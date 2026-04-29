import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const GLOBAL_PAGES_DIR = path.join(WIKI_ROOT, 'pages');

interface ProjectInfo {
  id: string;
  name: string | null;
  cwd: string;
}

const SLUG_REPLACE = /[^a-zA-Z0-9._-]/g;
function slugify(input: string): string {
  const cleaned = input.replace(SLUG_REPLACE, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'project';
}

function loadAllProjects(): ProjectInfo[] {
  const db = getDb();
  return db.prepare('SELECT id, name, cwd FROM projects').all() as ProjectInfo[];
}

function computeWikiSlug(
  projectId: string,
  cwd: string,
  allProjects: ProjectInfo[],
): string {
  const base = slugify(path.basename(cwd));
  const hasCollision = allProjects.some(
    (p) => p.id !== projectId && slugify(path.basename(p.cwd)) === base,
  );
  return hasCollision ? `${base}-${projectId.slice(0, 6)}` : base;
}

export function getProjectWikiSlugByProjectId(projectId: string): string {
  const all = loadAllProjects();
  const me = all.find((p) => p.id === projectId);
  if (!me) return projectId;
  return computeWikiSlug(projectId, me.cwd, all);
}

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
  projectCwd: string;
  lastSyncedMessageId: string | null;
}

function loadSessionContext(sessionId: string): SessionContext {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.last_synced_message_id,
              s.project_id,
              p.name AS project_name,
              p.cwd AS project_cwd
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        last_synced_message_id: string | null;
        project_id: string;
        project_name: string | null;
        project_cwd: string;
      }
    | undefined;
  if (!row) throw new Error(`session ${sessionId} not found`);
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    projectCwd: row.project_cwd,
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
  const slug = getProjectWikiSlugByProjectId(projectId);
  return path.join(WIKI_ROOT, 'projects', slug);
}

async function migrateLegacyProjectDir(
  projectId: string,
  targetRoot: string,
): Promise<void> {
  if (path.basename(targetRoot) === projectId) return;
  const legacy = path.join(WIKI_ROOT, 'projects', projectId);
  if (!existsSync(legacy)) return;
  if (existsSync(targetRoot)) return;
  await rename(legacy, targetRoot);
}

async function ensureWikiLayout(
  projectId: string,
  projectName: string | null,
  projectCwd: string,
  allProjects: ProjectInfo[],
): Promise<string> {
  // Global tier — cross-project knowledge. Created once, then user-managed.
  await mkdir(GLOBAL_PAGES_DIR, { recursive: true });

  const globalIndex = path.join(WIKI_ROOT, 'index.md');
  if (!existsSync(globalIndex)) {
    await writeFile(
      globalIndex,
      `# Personal pinloom wiki — global

Cross-project knowledge lives here. Project-specific notes are kept under
\`projects/<repo-name>/\` so they don't leak into other projects.

The AI reads both this directory and the active project's directory at
the start of each turn when prior knowledge might be relevant. Sync may
write to any project's directory if a captured insight clearly belongs
elsewhere — but never to this global tier. Promote a page here yourself
by moving it.

## Pages

_(empty — promote pages from \`projects/<repo>/pages/\` here when they
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
- \`~/.pinloom/wiki/projects/<repo-name>/pages/\` — **project-scoped**
  notes. Sync writes to the active project here, and may also route a
  page to another project's directory when an insight belongs elsewhere.

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

  // Project tier — keyed by a slug derived from the project's cwd basename
  // (e.g. /Users/me/Workspace/pims-frontend → pims-frontend) so the layout is
  // human-readable and stable across project rename/recreate as long as the
  // underlying repo path stays the same.
  const slug = computeWikiSlug(projectId, projectCwd, allProjects);
  const projectRoot = path.join(WIKI_ROOT, 'projects', slug);
  await migrateLegacyProjectDir(projectId, projectRoot);

  const projectPagesDir = path.join(projectRoot, 'pages');
  await mkdir(projectPagesDir, { recursive: true });

  const projectIndex = path.join(projectRoot, 'index.md');
  if (!existsSync(projectIndex)) {
    const heading = projectName ? `# ${projectName} wiki` : `# Project wiki`;
    await writeFile(
      projectIndex,
      `${heading}

Project-scoped knowledge for ${projectName ?? slug}. Decisions,
conventions, and gotchas that only apply inside this project. The AI
reads this directory plus the global tier on each turn.

## Pages

_(empty — your first \`Sync to wiki\` will populate this list)_
`,
      'utf8',
    );
  }

  return projectRoot;
}

interface ProjectScope {
  projectId: string;
  name: string | null;
  cwd: string;
  slug: string;
  isActive: boolean;
}

function buildProjectScopes(
  activeProjectId: string,
  activeCwd: string,
  allProjects: ProjectInfo[],
): ProjectScope[] {
  return allProjects.map((p) => ({
    projectId: p.id,
    name: p.name,
    cwd: p.cwd,
    slug: computeWikiSlug(p.id, p.cwd, allProjects),
    isActive: p.id === activeProjectId,
  }));
}

async function readWikiSnapshot(scopes: ProjectScope[]): Promise<string> {
  const parts: string[] = [];

  // Global tier — for context only; sync agent must not write here.
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

  // Active project — full content (index + every page).
  const active = scopes.find((s) => s.isActive);
  if (active) {
    const activeRoot = path.join(WIKI_ROOT, 'projects', active.slug);
    const activeIndex = path.join(activeRoot, 'index.md');
    if (existsSync(activeIndex)) {
      parts.push(
        `### ~/.pinloom/wiki/projects/${active.slug}/index.md (ACTIVE PROJECT — primary write target)\n\n${await readFile(activeIndex, 'utf8')}`,
      );
    }
    const activePagesDir = path.join(activeRoot, 'pages');
    let activePages: string[] = [];
    try {
      activePages = (await readdir(activePagesDir)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      activePages = [];
    }
    for (const name of activePages) {
      const full = path.join(activePagesDir, name);
      const body = await readFile(full, 'utf8');
      parts.push(
        `### ~/.pinloom/wiki/projects/${active.slug}/pages/${name} (ACTIVE PROJECT — primary write target)\n\n${body}`,
      );
    }
  }

  // Other projects — index only, so the agent knows what each one covers
  // before deciding to route a page there. Their pages are not bundled to
  // keep the prompt small; the agent has Read available for follow-up.
  for (const scope of scopes) {
    if (scope.isActive) continue;
    const otherIndex = path.join(WIKI_ROOT, 'projects', scope.slug, 'index.md');
    if (!existsSync(otherIndex)) continue;
    const body = await readFile(otherIndex, 'utf8');
    const label = scope.name ?? scope.slug;
    parts.push(
      `### ~/.pinloom/wiki/projects/${scope.slug}/index.md (OTHER PROJECT: ${label} — write here only for lessons clearly about this project)\n\n${body}`,
    );
  }

  return parts.join('\n\n---\n\n');
}

function buildSyncSystemPrompt(scopes: ProjectScope[]): string {
  const active = scopes.find((s) => s.isActive);
  if (!active) throw new Error('no active project scope');
  const activeLabel = active.name ?? active.slug;
  const otherProjects = scopes.filter((s) => !s.isActive);

  const otherList =
    otherProjects.length === 0
      ? '   _(no other pinloom projects registered)_'
      : otherProjects
          .map(
            (s) =>
              `   - **${s.name ?? s.slug}** (cwd \`${s.cwd}\`) → \`~/.pinloom/wiki/projects/${s.slug}/\``,
          )
          .join('\n');

  return `You maintain the user's personal knowledge wiki. There are three scopes:

1. **Global** — \`~/.pinloom/wiki/\` (cross-project knowledge). **READ-ONLY for you.**
   Do not create or modify anything under \`~/.pinloom/wiki/index.md\`,
   \`~/.pinloom/wiki/_schema.md\`, or \`~/.pinloom/wiki/pages/\`. Only the
   user promotes pages here.

2. **Active project** — \`${activeLabel}\` (cwd \`${active.cwd}\`).
   Path: \`~/.pinloom/wiki/projects/${active.slug}/\`. **PRIMARY WRITE TARGET.**
   Most insights from the conversation belong here.

3. **Other projects** — write here only when a captured insight is
   unmistakably about that project, not the active one (e.g. the user
   discussed a different repo's git rules during this session). Available:
${otherList}

## What to extract
- Decisions the user made (and the reasoning), scoped to a specific project
- Concepts learned, gotchas resolved, patterns discovered
- Project-specific conventions (git workflow, naming rules, build commands)

## What to skip
- Transient working state (e.g. a bug being actively debugged but not yet solved)
- Trivial details (file paths, one-off command output)
- Information already captured well in existing pages — only update if new
- Cross-project knowledge that already lives in the global tier (cite it instead)

## Routing decision

For each insight, ask: "Is this lesson specifically about the active
project, or about another listed project?"
- Default: write to the active project. When in doubt, default here.
- Other project: write there only if the conversation explicitly discussed
  that other project's repo, conventions, or code.
- Never write to global; if a lesson clearly transcends projects, mention
  it in the active project page and let the user promote it.

## How to write

1. Read \`~/.pinloom/wiki/_schema.md\` for organizational conventions.
2. Read the relevant project's \`index.md\` to see existing pages.
3. Create a new page or update an existing one in
   \`~/.pinloom/wiki/projects/<slug>/pages/\` for the chosen project.
4. Add cross-references with relative links between pages.
5. Mark contradictions: \`> **Conflict**: existing page says X; this session suggests Y.\`
6. Keep each touched project's \`index.md\` listing every page in that
   project with a one-line description.
7. Preserve user-written content outside \`<!-- pinloom:auto-section -->\`
   markers. Only edit inside those markers, or wrap new auto-managed
   content in them.

When done, summarize briefly: which pages you created or updated, and
which project each went into. No preamble.`;
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
  const allProjects = loadAllProjects();
  await ensureWikiLayout(ctx.projectId, ctx.projectName, ctx.projectCwd, allProjects);

  const scopes = buildProjectScopes(ctx.projectId, ctx.projectCwd, allProjects);
  // Make sure every other project's directory exists too — otherwise the
  // agent has nowhere to write to if it decides to route a page elsewhere.
  for (const scope of scopes) {
    if (scope.isActive) continue;
    await ensureWikiLayout(scope.projectId, scope.name, scope.cwd, allProjects);
  }

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

  const wikiSnapshot = await readWikiSnapshot(scopes);

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

  // cwd is the wiki root so the agent can navigate freely between project
  // directories. permissionMode: 'bypassPermissions' already lets it write
  // anywhere; the cwd choice is mostly cosmetic for the agent's mental model.
  const abortController = new AbortController();
  const q = query({
    prompt,
    options: {
      cwd: WIKI_ROOT,
      systemPrompt: buildSyncSystemPrompt(scopes),
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
