import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const WIKI_PAGES_DIR = path.join(WIKI_ROOT, 'pages');

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

function loadMessagesSinceSync(sessionId: string): {
  messages: SyncMessageRow[];
  lastMessageId: string | null;
} {
  const db = getDb();
  const session = db
    .prepare('SELECT last_synced_message_id FROM sessions WHERE id = ?')
    .get(sessionId) as { last_synced_message_id: string | null } | undefined;
  if (!session) throw new Error(`session ${sessionId} not found`);

  let rows: SyncMessageRow[];
  if (session.last_synced_message_id) {
    const cutoff = db
      .prepare('SELECT created_at FROM messages WHERE id = ?')
      .get(session.last_synced_message_id) as { created_at: string } | undefined;
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

async function ensureWikiLayout(): Promise<void> {
  await mkdir(WIKI_PAGES_DIR, { recursive: true });

  const indexPath = path.join(WIKI_ROOT, 'index.md');
  if (!existsSync(indexPath)) {
    await writeFile(
      indexPath,
      `# Personal pinloom wiki

This is your personal knowledge base, written and maintained by pinloom from
your sessions. The AI reads this file (and the pages below) at the start of
new turns when prior knowledge might be relevant.

## Pages

_(empty — your first \`Sync to wiki\` will populate this list)_
`,
      'utf8',
    );
  }

  const schemaPath = path.join(WIKI_ROOT, '_schema.md');
  if (!existsSync(schemaPath)) {
    await writeFile(
      schemaPath,
      `# Wiki schema

Edit this file to tell the AI how you want the wiki organized. The sync agent
reads this on every run.

## Conventions

- One topic per page in \`pages/\`
- Use kebab-case filenames (e.g. \`react-hooks-patterns.md\`)
- Each page should start with a one-line description for the index
- Cross-reference pages with markdown links: \`[topic](./other-page.md)\`
- Mark known contradictions explicitly with a "**Conflict**" callout

## Editing

Anything you write in this wiki by hand is preserved. The sync agent only
modifies content inside \`<!-- pinloom:auto-section -->\` ... \`<!-- /pinloom:auto-section -->\`
blocks within each page.
`,
      'utf8',
    );
  }
}

async function readWikiSnapshot(): Promise<string> {
  await ensureWikiLayout();
  const parts: string[] = [];

  const indexPath = path.join(WIKI_ROOT, 'index.md');
  parts.push(`### ~/.pinloom/wiki/index.md\n\n${await readFile(indexPath, 'utf8')}`);

  const schemaPath = path.join(WIKI_ROOT, '_schema.md');
  parts.push(`### ~/.pinloom/wiki/_schema.md\n\n${await readFile(schemaPath, 'utf8')}`);

  let pages: string[] = [];
  try {
    pages = (await readdir(WIKI_PAGES_DIR)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    pages = [];
  }

  for (const name of pages) {
    const full = path.join(WIKI_PAGES_DIR, name);
    const body = await readFile(full, 'utf8');
    parts.push(`### ~/.pinloom/wiki/pages/${name}\n\n${body}`);
  }

  return parts.join('\n\n---\n\n');
}

const SYNC_SYSTEM_PROMPT = `You maintain a personal knowledge wiki at \`~/.pinloom/wiki/\` for the user.

Your job: read the conversation snippet provided below, distill durable
knowledge from it, and integrate that knowledge into the existing wiki using
your filesystem tools.

## What to extract
- Decisions the user made (and the reasoning)
- Concepts learned, gotchas resolved, patterns discovered
- Cross-cutting insights that apply beyond this single session

## What to skip
- Transient working state (e.g. a bug being actively debugged but not yet solved)
- Trivial details (file paths, one-off command output)
- Information already captured well in existing pages — only update if new

## How to write

1. Read \`~/.pinloom/wiki/_schema.md\` for the user's organizational conventions.
2. Read \`~/.pinloom/wiki/index.md\` to see existing pages.
3. For each insight, decide: create a new page in \`~/.pinloom/wiki/pages/\` OR
   update an existing page.
4. Add cross-references with relative links between pages.
5. If you find a contradiction with existing content, mark it explicitly:
   \`> **Conflict**: existing page says X; this session suggests Y.\`
6. Update \`index.md\` so it lists every page with a one-line description.
7. Preserve any user-written content outside \`<!-- pinloom:auto-section -->\`
   markers. Only edit inside those markers, or wrap new auto-managed content in
   them.

When done, briefly summarize what you did (which pages you created or updated).
Be concise — no preamble, just the result.`;

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

  await ensureWikiLayout();

  const { messages, lastMessageId } = loadMessagesSinceSync(sessionId);
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

  const wikiSnapshot = await readWikiSnapshot();

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

  const abortController = new AbortController();
  const q = query({
    prompt,
    options: {
      cwd: WIKI_ROOT,
      systemPrompt: SYNC_SYSTEM_PROMPT,
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
