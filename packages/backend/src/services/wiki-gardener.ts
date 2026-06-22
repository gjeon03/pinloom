// Wiki gardener agent (docs/knowledge-system-v2.md, Phase 2b). Reads the wiki
// and proposes cleanups — it NEVER writes pages. It emits structured proposal
// intents (kind + target + payload); pinloom validates each and stages it via
// createProposal, and the user reviews/accepts in the inbox. The apply itself
// is the deterministic curation primitive (#125), never the agent.
//
// The SDK call is behind a `runAgent(prompt) => text` seam so the
// orchestration + parsing + validation are fully unit-testable without an LLM
// (the real LLM run is exercised in production, where auth exists).

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { WikiProposal, WikiProposalKind } from '@pinloom/shared';
import { getWikiRoot } from './wiki-reader.js';
import { createProposal } from './wiki-proposals.js';

export class GardenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GardenerError';
  }
}

const DEFAULT_GARDENER_MODEL = 'claude-sonnet-4-6';
// Bound how much wiki text we feed the model so a huge wiki can't blow the
// context (and the per-turn cost). Pages beyond this are skipped this run.
const SNAPSHOT_CHAR_BUDGET = 120_000;
// Wall-clock cap so a hung/slow stream can't pin the request forever
// (maxTurns bounds turns, not time). Mirrors the team-dispatch 5-min ceiling.
const GARDENER_TIMEOUT_MS = 5 * 60_000;
const KINDS = new Set<WikiProposalKind>(['edit_section', 'archive_page']);

export type RunAgent = (prompt: string, model: string) => Promise<string>;

// Real SDK call: read-only (no Edit/Write tools), collect the final text.
const defaultRunAgent: RunAgent = async (prompt, model) => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), GARDENER_TIMEOUT_MS);
  const q = query({
    prompt,
    options: {
      cwd: getWikiRoot(),
      systemPrompt: GARDENER_SYSTEM_PROMPT,
      model,
      maxTurns: 20,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Glob', 'Grep'],
      abortController,
    } as Parameters<typeof query>[0]['options'],
  });
  let out = '';
  try {
    for await (const message of q) {
      const m = message as unknown as {
        type: string;
        message?: { content?: Array<{ type: string; text?: string }> };
        result?: string;
        subtype?: string;
      };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) out = block.text;
        }
      } else if (m.type === 'result' && m.subtype === 'success' && m.result) {
        // The final answer is the `result`; "longest wins" guards against an
        // empty final frame, not a giant intermediate one (parse is tolerant).
        if (m.result.length > out.length) out = m.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
};

const GARDENER_SYSTEM_PROMPT = `You are the pinloom wiki gardener. You review a per-project markdown knowledge wiki and propose CLEANUPS. You never edit files — you only return a JSON array of proposals that a human reviews before anything is applied.

Each page has YAML frontmatter and an auto-section block marked
<!-- pinloom:auto-section --> ... <!-- /pinloom:auto-section -->. You may ONLY
propose changes to the auto-section body (via edit_section) or propose
archiving a whole page (via archive_page). Never touch frontmatter or the
user-owned prose outside the markers.

Return ONLY a JSON array (no prose, no code fences). Each element:
  { "kind": "edit_section", "title": "<short summary>", "relPath": "<page.md>", "payload": { "newSectionContent": "<the FULL new auto-section body>" } }
  { "kind": "archive_page", "title": "<short summary>", "relPath": "<page.md>", "payload": { "reason": "<why>", "supersededBy": "<other.md or omit>" } }

Be conservative: only propose changes that clearly improve the wiki (tighten a
bloated summary, fix an obviously stale instruction, merge a duplicate page by
archiving the redundant one). When unsure, propose nothing. Return [] if the
wiki is already clean.`;

async function readSnapshot(
  root: string,
): Promise<{ text: string; truncated: boolean }> {
  const parts: string[] = [];
  let budget = SNAPSHOT_CHAR_BUDGET;
  let truncated = false;
  const indexFile = path.join(root, 'index.md');
  if (existsSync(indexFile)) {
    const idx = await readFile(indexFile, 'utf8');
    parts.push(`# index.md\n\n${idx}`);
    budget -= idx.length;
  }
  const pagesDir = path.join(root, 'pages');
  if (existsSync(pagesDir)) {
    const files = (await readdir(pagesDir)).filter((f) => f.endsWith('.md')).sort();
    for (const f of files) {
      if (budget <= 0) {
        truncated = true; // remaining pages weren't shown to the gardener
        break;
      }
      const body = await readFile(path.join(pagesDir, f), 'utf8');
      parts.push(`# pages/${f}\n\n${body}`);
      budget -= body.length + f.length;
    }
  }
  return { text: parts.join('\n\n---\n\n'), truncated };
}

// Keep only the payload keys each kind actually uses, so an LLM can't smuggle
// extra fields into the stored proposal.
function whitelistPayload(
  kind: WikiProposalKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'edit_section') {
    return { newSectionContent: payload.newSectionContent };
  }
  return { reason: payload.reason, supersededBy: payload.supersededBy };
}

interface RawProposal {
  kind: string;
  title: string;
  relPath: string;
  payload: Record<string, unknown>;
}

// From `s[start]` (a '['), return the balanced-bracket substring through its
// matching ']', or null if unbalanced. String literals (and their escapes) are
// skipped so a ']' inside a JSON string doesn't close the array early.
function balancedArray(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i += 1; // skip escaped char
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Tolerant extraction: the model is told to return a bare JSON array, but a
// fenced block or prose (which may itself contain "[x]" brackets) is common.
// Prefer a ```fenced``` block, then scan every '[' for the first balanced
// substring that parses as an array — so leading prose brackets don't poison
// the slice. Throws only when no parseable array exists anywhere.
export function parseProposals(text: string): RawProposal[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const sources = fence ? [fence[1], text] : [text];
  for (const src of sources) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== '[') continue;
      const candidate = balancedArray(src, i);
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed as RawProposal[];
      } catch {
        // not the array — keep scanning
      }
    }
  }
  throw new GardenerError('gardener did not return a JSON array of proposals');
}

function validShape(p: unknown): p is RawProposal {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.kind === 'string' &&
    KINDS.has(r.kind as WikiProposalKind) &&
    typeof r.title === 'string' &&
    r.title.trim() !== '' &&
    typeof r.relPath === 'string' &&
    r.relPath.trim() !== '' &&
    !!r.payload &&
    typeof r.payload === 'object'
  );
}

export interface GardenResult {
  created: WikiProposal[];
  skipped: number;
  /** True when the wiki exceeded the snapshot budget and some pages weren't reviewed. */
  truncated: boolean;
}

/**
 * Run a gardening pass: ask the agent for proposals, then validate + stage each
 * via createProposal (which enforces path safety, payload shape, and pins the
 * staleness hash). Malformed proposals are skipped, not fatal.
 */
export async function runGardener(
  opts: { model?: string; root?: string; runAgent?: RunAgent; now?: string } = {},
): Promise<GardenResult> {
  const root = opts.root ?? getWikiRoot();
  const { text: snapshot, truncated } = await readSnapshot(root);
  if (snapshot.trim() === '') return { created: [], skipped: 0, truncated };

  const text = await (opts.runAgent ?? defaultRunAgent)(
    snapshot,
    opts.model ?? DEFAULT_GARDENER_MODEL,
  );
  const raw = parseProposals(text);

  const created: WikiProposal[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (!validShape(item)) {
      skipped += 1;
      continue;
    }
    const kind = item.kind as WikiProposalKind;
    try {
      created.push(
        await createProposal(
          {
            kind,
            title: item.title.trim(),
            relPath: item.relPath,
            payload: whitelistPayload(kind, item.payload),
          },
          { root, now: opts.now },
        ),
      );
    } catch {
      // createProposal rejects unsafe paths / bad payloads / missing pages.
      skipped += 1;
    }
  }
  return { created, skipped, truncated };
}
