import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const GLOBAL_PAGES_DIR = path.join(WIKI_ROOT, 'pages');

const DEFAULT_SYNC_MODEL = 'claude-sonnet-4-6';

interface SyncMessageRow {
  id: string;
  role: string;
  content: string;
  tool_use: string | null;
  created_at: string;
}

interface FilteredMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_CODE_BLOCK_LINES = 30;

function compressCodeBlocks(text: string): string {
  return text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const lines = body.split('\n');
    if (lines.length <= MAX_CODE_BLOCK_LINES) return `\`\`\`${lang}\n${body}\`\`\``;
    return `\`\`\`${lang}\n[code: ${lines.length} lines${lang ? `, ${lang}` : ''}]\n\`\`\``;
  });
}

function summarizeToolMessage(row: SyncMessageRow): string | null {
  if (!row.tool_use) return null;
  try {
    const tool = JSON.parse(row.tool_use) as {
      name?: string;
      input?: Record<string, unknown>;
    };
    const name = tool.name ?? 'tool';
    const input = tool.input ?? {};
    if (typeof input.command === 'string') return `[${name}: ${input.command.slice(0, 80)}]`;
    if (typeof input.file_path === 'string') return `[${name}: ${input.file_path}]`;
    if (typeof input.pattern === 'string') return `[${name}: ${input.pattern}]`;
    return `[${name}]`;
  } catch {
    return '[tool]';
  }
}

function filterMessages(rows: SyncMessageRow[]): FilteredMessage[] {
  const out: FilteredMessage[] = [];
  for (const row of rows) {
    if (row.role === 'system') continue;
    if (row.role === 'tool') {
      const summary = summarizeToolMessage(row);
      if (summary && out.length > 0) {
        const last = out[out.length - 1];
        if (last.role === 'assistant') {
          last.content = `${last.content}\n${summary}`;
        }
      }
      continue;
    }
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const content = compressCodeBlocks(row.content).trim();
    if (!content) continue;
    out.push({ role: row.role, content });
  }
  return out;
}

interface SessionContext {
  projectId: string;
  projectName: string | null;
  lastSyncedMessageId: string | null;
}

function loadSessionContext(sessionId: string): SessionContext {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.last_synced_message_id, s.project_id, p.name AS project_name
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        last_synced_message_id: string | null;
        project_id: string;
        project_name: string | null;
      }
    | undefined;
  if (!row) throw new Error(`session ${sessionId} not found`);
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    lastSyncedMessageId: row.last_synced_message_id,
  };
}

function loadMessagesSinceSync(
  sessionId: string,
  lastSyncedMessageId: string | null,
): { messages: SyncMessageRow[]; lastMessageId: string | null } {
  const db = getDb();
  let rows: SyncMessageRow[];
  if (lastSyncedMessageId) {
    const cutoff = db
      .prepare('SELECT created_at FROM messages WHERE id = ?')
      .get(lastSyncedMessageId) as { created_at: string } | undefined;
    if (!cutoff) {
      rows = db
        .prepare(
          `SELECT id, role, content, tool_use, created_at
           FROM messages
           WHERE session_id = ? AND source_message_id IS NULL
           ORDER BY created_at ASC`,
        )
        .all(sessionId) as SyncMessageRow[];
    } else {
      rows = db
        .prepare(
          `SELECT id, role, content, tool_use, created_at
           FROM messages
           WHERE session_id = ? AND source_message_id IS NULL
                 AND created_at > ?
           ORDER BY created_at ASC`,
        )
        .all(sessionId, cutoff.created_at) as SyncMessageRow[];
    }
  } else {
    rows = db
      .prepare(
        `SELECT id, role, content, tool_use, created_at
         FROM messages
         WHERE session_id = ? AND source_message_id IS NULL
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as SyncMessageRow[];
  }

  const lastMessageId = rows.length > 0 ? rows[rows.length - 1].id : null;
  return { messages: rows, lastMessageId };
}

export function getProjectWikiRoot(projectId: string): string {
  return path.join(WIKI_ROOT, 'projects', projectId);
}

async function ensureWikiLayout(projectId: string, projectName: string | null): Promise<void> {
  // Global tier — cross-project knowledge. Created once, then user-managed.
  await mkdir(GLOBAL_PAGES_DIR, { recursive: true });

  const globalIndex = path.join(WIKI_ROOT, 'index.md');
  if (!existsSync(globalIndex)) {
    await writeFile(
      globalIndex,
      `# Personal pinloom wiki — global

Cross-project knowledge lives here. Project-specific notes are kept under
\`projects/<projectId>/\` so they don't leak into other projects.

The AI reads both this directory and the active project's directory at
the start of each turn when prior knowledge might be relevant. Sync only
ever writes to the active project's directory — promote a page to the
global tier by moving it here yourself.

## Pages

_(empty — promote pages from \`projects/<id>/pages/\` here when they
apply across projects)_
`,
      'utf8',
    );
  }

  const globalSchema = path.join(WIKI_ROOT, '_schema.md');
  if (!existsSync(globalSchema)) {
    await writeFile(
      globalSchema,
      `# Wiki schema

Edit this file to tell the AI how you want the wiki organized. The sync
agent reads both this file and the project-level \`_schema.md\` if present.

## Tiers

- \`~/.pinloom/wiki/pages/\` — **global** cross-project knowledge. Curated
  by you. Sync never writes here.
- \`~/.pinloom/wiki/projects/<projectId>/pages/\` — **project-scoped**
  notes. Sync writes here automatically.

## Conventions

- One topic per page in \`pages/\`
- Use kebab-case filenames (e.g. \`react-hooks-patterns.md\`)
- Each page should start with a one-line description for the index
- Cross-reference pages with markdown links: \`[topic](./other-page.md)\`
- Mark known contradictions explicitly with a "**Conflict**" callout

## Editing

Anything you write in this wiki by hand is preserved. The sync agent
only modifies content inside \`<!-- pinloom:auto-section -->\` ...
\`<!-- /pinloom:auto-section -->\` blocks within each page.
`,
      'utf8',
    );
  }

  // Project tier — created on demand for the active project.
  const projectRoot = getProjectWikiRoot(projectId);
  const projectPagesDir = path.join(projectRoot, 'pages');
  await mkdir(projectPagesDir, { recursive: true });

  const projectIndex = path.join(projectRoot, 'index.md');
  if (!existsSync(projectIndex)) {
    const heading = projectName ? `# ${projectName} wiki` : `# Project wiki`;
    await writeFile(
      projectIndex,
      `${heading}

Project-scoped knowledge for ${projectName ?? projectId}. Decisions,
conventions, and gotchas that only apply inside this project. The AI
reads this directory plus the global tier on each turn.

## Pages

_(empty — your first \`Sync to wiki\` will populate this list)_
`,
      'utf8',
    );
  }
}

async function readWikiSnapshot(projectId: string): Promise<string> {
  const parts: string[] = [];

  // Global tier — for context only; sync agent should not write here.
  const globalIndex = path.join(WIKI_ROOT, 'index.md');
  if (existsSync(globalIndex)) {
    parts.push(`### ~/.pinloom/wiki/index.md (GLOBAL — read-only for sync)\n\n${await readFile(globalIndex, 'utf8')}`);
  }
  const globalSchema = path.join(WIKI_ROOT, '_schema.md');
  if (existsSync(globalSchema)) {
    parts.push(`### ~/.pinloom/wiki/_schema.md\n\n${await readFile(globalSchema, 'utf8')}`);
  }
  let globalPages: string[] = [];
  try {
    globalPages = (await readdir(GLOBAL_PAGES_DIR)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    globalPages = [];
  }
  for (const name of globalPages) {
    const full = path.join(GLOBAL_PAGES_DIR, name);
    const body = await readFile(full, 'utf8');
    parts.push(`### ~/.pinloom/wiki/pages/${name} (GLOBAL — read-only for sync)\n\n${body}`);
  }

  // Project tier — sync agent writes here.
  const projectRoot = getProjectWikiRoot(projectId);
  const projectIndex = path.join(projectRoot, 'index.md');
  if (existsSync(projectIndex)) {
    parts.push(
      `### ~/.pinloom/wiki/projects/${projectId}/index.md (PROJECT — sync target)\n\n${await readFile(projectIndex, 'utf8')}`,
    );
  }
  const projectPagesDir = path.join(projectRoot, 'pages');
  let projectPages: string[] = [];
  try {
    projectPages = (await readdir(projectPagesDir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    projectPages = [];
  }
  for (const name of projectPages) {
    const full = path.join(projectPagesDir, name);
    const body = await readFile(full, 'utf8');
    parts.push(
      `### ~/.pinloom/wiki/projects/${projectId}/pages/${name} (PROJECT — sync target)\n\n${body}`,
    );
  }

  return parts.join('\n\n---\n\n');
}

function buildSyncSystemPrompt(projectId: string, projectName: string | null): string {
  return `You maintain a personal knowledge wiki for the user. The wiki has two tiers:

1. **Global**: \`~/.pinloom/wiki/\` (cross-project knowledge). **READ-ONLY for you.**
   Only the user promotes pages here. Do not create or modify any file under
   \`~/.pinloom/wiki/index.md\`, \`~/.pinloom/wiki/_schema.md\`, or
   \`~/.pinloom/wiki/pages/\`.
2. **Project**: \`~/.pinloom/wiki/projects/${projectId}/\` (notes for the
   active project, ${projectName ?? projectId}). **THIS IS YOUR WORKSPACE.**

Your job: read the conversation snippet provided below, distill durable
knowledge from it, and write it into the **project** tier using your
filesystem tools. The global tier is provided in the snapshot purely as
context so you don't redundantly capture cross-project things that already
live there.

## What to extract
- Decisions the user made (and the reasoning), scoped to this project
- Concepts learned, gotchas resolved, patterns discovered while working here
- Project-specific conventions (git workflow, naming rules, build commands)

## What to skip
- Transient working state (e.g. a bug being actively debugged but not yet solved)
- Trivial details (file paths, one-off command output)
- Information already captured well in existing project pages — only update if new
- Cross-project knowledge that already lives in the global tier (cite it instead)

## How to write

1. Read \`~/.pinloom/wiki/_schema.md\` for the user's organizational conventions.
2. Read \`~/.pinloom/wiki/projects/${projectId}/index.md\` to see existing pages.
3. For each insight, decide: create a new page in
   \`~/.pinloom/wiki/projects/${projectId}/pages/\` OR update an existing one.
4. Add cross-references with relative links between pages.
5. If a contradiction shows up with existing content, mark it explicitly:
   \`> **Conflict**: existing page says X; this session suggests Y.\`
6. Update \`~/.pinloom/wiki/projects/${projectId}/index.md\` so it lists every
   page in this project with a one-line description.
7. Preserve user-written content outside \`<!-- pinloom:auto-section -->\`
   markers. Only edit inside those markers, or wrap new auto-managed
   content in them.

When done, briefly summarize what you did (which pages you created or
updated). Be concise — no preamble, just the result.`;
}

interface SyncResult {
  output: string;
  lastSyncedMessageId: string | null;
  messageCount: number;
}

export async function runWikiSync(args: {
  sessionId: string;
  model?: string;
}): Promise<SyncResult> {
  const { sessionId, model = DEFAULT_SYNC_MODEL } = args;

  const ctx = loadSessionContext(sessionId);
  await ensureWikiLayout(ctx.projectId, ctx.projectName);

  const { messages, lastMessageId } = loadMessagesSinceSync(
    sessionId,
    ctx.lastSyncedMessageId,
  );
  if (messages.length === 0) {
    return {
      output: 'No new messages since last sync. Wiki is up to date.',
      lastSyncedMessageId: null,
      messageCount: 0,
    };
  }

  const filtered = filterMessages(messages);
  if (filtered.length === 0) {
    return {
      output: 'New messages contained no syncable content.',
      lastSyncedMessageId: lastMessageId,
      messageCount: messages.length,
    };
  }

  const wikiSnapshot = await readWikiSnapshot(ctx.projectId);

  const transcript = filtered
    .map((m) => `### ${m.role === 'user' ? 'User' : 'AI'}\n\n${m.content}`)
    .join('\n\n---\n\n');

  const prompt = [
    '# Existing wiki snapshot',
    '',
    wikiSnapshot,
    '',
    '---',
    '',
    '# Conversation snippet to ingest',
    '',
    transcript,
  ].join('\n');

  const projectRoot = getProjectWikiRoot(ctx.projectId);
  const abortController = new AbortController();
  const q = query({
    prompt,
    options: {
      cwd: projectRoot,
      systemPrompt: buildSyncSystemPrompt(ctx.projectId, ctx.projectName),
      model,
      maxTurns: 30,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      abortController,
    } as Parameters<typeof query>[0]['options'],
  });

  let summary = '';
  try {
    for await (const message of q) {
      const anyMsg = message as unknown as {
        type: string;
        message?: {
          content?: Array<{ type: string; text?: string }>;
        };
        result?: string;
        subtype?: string;
      };
      if (anyMsg.type === 'assistant') {
        const content = anyMsg.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            summary = block.text;
          }
        }
      } else if (anyMsg.type === 'result' && anyMsg.subtype === 'success' && anyMsg.result) {
        if (anyMsg.result.length > summary.length) summary = anyMsg.result;
      }
    }
  } finally {
    try {
      const maybeClose = (q as unknown as { close?: () => void }).close;
      if (typeof maybeClose === 'function') maybeClose.call(q);
    } catch {
      // best-effort cleanup
    }
  }

  if (lastMessageId) {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        'UPDATE sessions SET last_synced_message_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(lastMessageId, now, sessionId);
  }

  return {
    output: summary || 'Sync completed. (No summary returned.)',
    lastSyncedMessageId: lastMessageId,
    messageCount: messages.length,
  };
}

export function getWikiRoot(): string {
  return WIKI_ROOT;
}
