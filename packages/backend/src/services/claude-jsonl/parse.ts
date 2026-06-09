// Pure functions that turn Claude Code transcript JSONL into the same
// `NormalizedEvent` stream the SDK/Codex adapters produce. No I/O here — the
// caller hands us already-read lines so this stays trivially unit-testable
// against recorded fixtures (the riskiest logic in the PTY path, isolated).
//
// Two responsibilities:
//   1. parseJsonlLine        — one raw line  -> typed JsonlLine (or null)
//   2. extractTurnLines      — given a checkpoint uuid, pick out exactly the
//                              lines belonging to the turn the injected prompt
//                              kicked off (parentUuid descendants), dropping
//                              sidechains/noise/synthetic.
//   3. toNormalizedEvents    — those lines -> NormalizedEvent[]
//
// Reused by: the PTY completion detector (turn extraction) AND the usage meter
// / issue #21 progress bar (token accounting in ./usage.ts).

import type { NormalizedEvent } from '../agents/types.js';
import {
  NOISE_TYPES,
  SYNTHETIC_MODEL,
  type JsonlContentBlock,
  type JsonlLine,
} from './types.js';

/**
 * Parse a single transcript line. Returns null for blank lines, JSON parse
 * errors, or objects without a string `type` — callers skip nulls so a
 * partially-written tail line never throws.
 */
export function parseJsonlLine(raw: string): JsonlLine | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const line = obj as JsonlLine;
  if (typeof line.type !== 'string') return null;
  return line;
}

/** Parse a whole transcript blob, dropping unparseable lines. */
export function parseJsonlLines(raw: string): JsonlLine[] {
  const out: JsonlLine[] = [];
  for (const l of raw.split('\n')) {
    const parsed = parseJsonlLine(l);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isSynthetic(line: JsonlLine): boolean {
  return line.message?.model === SYNTHETIC_MODEL;
}

/**
 * Pick out the lines that belong to the turn started by the prompt we injected
 * right after `checkpointUuid`.
 *
 * Strategy: the injected user prompt is the first non-noise line whose
 * `parentUuid === checkpointUuid`. From there we walk forward collecting every
 * line whose `parentUuid` is already in the collected set — i.e. the descendant
 * subtree rooted at the injected prompt. This is robust against a *concurrent*
 * injection writing interleaved lines (those descend from a different root) and
 * against trailing lines from a later turn.
 *
 * `checkpointUuid === null` means "fresh session, no prior lines" — the root is
 * then the first non-noise user line in the file.
 *
 * Sidechain (subagent) lines, noise types, and synthetic messages are dropped.
 */
export function extractTurnLines(
  lines: JsonlLine[],
  checkpointUuid: string | null,
): JsonlLine[] {
  const root = lines.find(
    (l) =>
      !NOISE_TYPES.has(l.type) &&
      !l.isSidechain &&
      l.type === 'user' &&
      (checkpointUuid === null
        ? l.parentUuid === null || l.parentUuid === undefined
        : l.parentUuid === checkpointUuid),
  );
  if (!root || !root.uuid) return [];

  const collected = new Set<string>([root.uuid]);
  const turn: JsonlLine[] = [];

  for (const line of lines) {
    if (line.uuid === root.uuid) continue; // skip the injected prompt itself
    if (NOISE_TYPES.has(line.type)) continue;
    if (line.isSidechain) continue;
    if (isSynthetic(line)) continue;
    // Belongs to the turn iff its parent is something we've already collected.
    if (line.parentUuid && collected.has(line.parentUuid)) {
      if (line.uuid) collected.add(line.uuid);
      turn.push(line);
    }
  }
  return turn;
}

function blocksOf(line: JsonlLine): JsonlContentBlock[] {
  const content = line.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && 'text' in b) {
          const t = (b as { text?: unknown }).text;
          if (typeof t === 'string') return t;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Mirrors summarizeToolCall in claude-adapter.ts so the UI renders PTY tool
// calls identically to SDK ones.
function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${name}: ${input.command}`;
  if (typeof input.file_path === 'string') {
    const extra =
      typeof input.old_string === 'string'
        ? ' (edit)'
        : typeof input.content === 'string'
          ? ' (write)'
          : '';
    return `${name}: ${input.file_path}${extra}`;
  }
  if (typeof input.pattern === 'string') return `${name}: ${input.pattern}`;
  return name;
}

/**
 * Map already-extracted turn lines to the NormalizedEvent stream. Emits, in
 * order: a single `session_id` (if known) and `model` (first real model seen),
 * then per assistant block (thinking/text/tool_use) and per user tool_result,
 * and finally one `turn_complete`.
 *
 * Text blocks emit `text_delta` (full text) + `text_block_end`, matching how
 * the Codex adapter surfaces a completed message (the runner treats a
 * full-text delta the same as accumulated streaming deltas).
 */
export function toNormalizedEvents(
  turnLines: JsonlLine[],
  opts: { sessionId?: string | null } = {},
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (opts.sessionId) events.push({ type: 'session_id', id: opts.sessionId });

  let modelEmitted = false;

  for (const line of turnLines) {
    if (line.type === 'assistant') {
      const model = line.message?.model;
      if (!modelEmitted && model && model !== SYNTHETIC_MODEL) {
        events.push({ type: 'model', model });
        modelEmitted = true;
      }
      for (const block of blocksOf(line)) {
        if (block.type === 'thinking') {
          const text = typeof block.thinking === 'string' ? block.thinking : '';
          if (text) {
            events.push({ type: 'thinking_start' });
            events.push({ type: 'thinking_delta', text });
          }
        } else if (block.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) {
            events.push({ type: 'text_delta', text });
            events.push({ type: 'text_block_end' });
          }
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          events.push({
            type: 'tool_use',
            name,
            input,
            summary: summarizeToolCall(name, input),
          });
        }
      }
    } else if (line.type === 'user') {
      for (const block of blocksOf(line)) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content);
          if (text) {
            events.push({
              type: 'tool_result',
              text,
              stream: block.is_error ? 'stderr' : 'stdout',
            });
          }
        }
      }
    }
  }

  events.push({ type: 'turn_complete' });
  return events;
}
