import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const PAGES_DIR = path.join(WIKI_ROOT, 'pages');
const SCHEMA_FILE = path.join(WIKI_ROOT, '_schema.md');
const INDEX_FILE = path.join(WIKI_ROOT, 'index.md');
const LEGACY_PROJECTS_DIR = path.join(WIKI_ROOT, 'projects');

const DEFAULT_SYNC_MODEL = 'claude-sonnet-4-6';

const AUTO_SECTION_OPEN = '<!-- pinloom:auto-section -->';
const AUTO_SECTION_CLOSE = '<!-- /pinloom:auto-section -->';

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

export function getWikiRoot(): string {
  return WIKI_ROOT;
}

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

function hasFrontmatter(body: string): boolean {
  return /^---\s*\n[\s\S]*?\n---\s*(\n|$)/.test(body);
}

function extractFirstNonHeadingLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('<!--')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return '';
}

function buildFrontmatter(args: {
  appliesTo: string[];
  topics?: string[];
  related?: string[];
  summary: string;
}): string {
  const fm: string[] = ['---'];
  if (args.appliesTo.length > 0) {
    fm.push(`applies_to: [${args.appliesTo.join(', ')}]`);
  } else {
    fm.push('applies_to: [global]');
  }
  fm.push(`topic: [${(args.topics ?? []).join(', ')}]`);
  fm.push(`related: [${(args.related ?? []).join(', ')}]`);
  fm.push(`summary: ${JSON.stringify(args.summary)}`);
  fm.push('---', '');
  return fm.join('\n');
}

const DEFAULT_SCHEMA = `# Wiki schema

User-editable. The sync agent reads this on every run to learn how the
wiki should be organized.

## Frontmatter (required for every page)

\`\`\`yaml
---
applies_to: [<projectSlug>...]   # pinloom project slugs; omit or [global] = applies everywhere
topic: [<tag>...]                # topical tags (free-form, e.g. git, react, deploy, debugging)
related: [<filename>...]         # other pages explicitly relevant to this one
summary: "<one-line description>"
---
\`\`\`

## Filename conventions

- kebab-case
- Project-specific page: suffix with project slug
  (e.g. \`git-conventions-pims-frontend.md\`)
- Cross-project page: generic name (e.g. \`react-hooks-patterns.md\`)

## Index

\`index.md\` is auto-maintained by the sync agent inside the
${AUTO_SECTION_OPEN} ... ${AUTO_SECTION_CLOSE} block. Pages are grouped
into sections by their primary \`topic\`. Anything outside the markers
is user-owned and preserved across runs.

## Auto vs manual content within pages

The AI only edits inside ${AUTO_SECTION_OPEN} ... ${AUTO_SECTION_CLOSE}
markers within each page. Anything outside is user-owned. You can
hand-edit frontmatter, rewrite sections, add notes — the sync agent
preserves it.

## Page-level evolution

When a single page grows beyond ~5000 chars or has 5+ major sections,
you can promote it to a directory:

\`\`\`
pages/<name>.md   →   pages/<name>/
                       ├── index.md      (entry, with frontmatter)
                       ├── workflow.md
                       └── examples.md
\`\`\`

The reading agent treats \`pages/<name>.md\` and \`pages/<name>/index.md\`
as equivalent entry points. Promotion is a per-page decision.
`;

const DEFAULT_INDEX = `# Personal pinloom wiki

The AI reads this index at the start of each turn to find relevant
pages. Each page declares its scope via \`applies_to\` frontmatter —
the AI must filter by the active project's slug before applying any
rules from a page.

${AUTO_SECTION_OPEN}

_(empty — your first \`Sync to wiki\` will populate this list)_

${AUTO_SECTION_CLOSE}
`;

async function ensureWikiLayout(): Promise<void> {
  await mkdir(PAGES_DIR, { recursive: true });
  if (!existsSync(SCHEMA_FILE)) {
    await writeFile(SCHEMA_FILE, DEFAULT_SCHEMA, 'utf8');
  }
  if (!existsSync(INDEX_FILE)) {
    await writeFile(INDEX_FILE, DEFAULT_INDEX, 'utf8');
  }
}

interface MigrationReport {
  projectPagesMoved: number;
  globalPagesAnnotated: number;
  legacyDirsRemoved: number;
  indexRewritten: boolean;
  schemaRewritten: boolean;
}

async function migrateLegacyLayout(): Promise<MigrationReport> {
  const report: MigrationReport = {
    projectPagesMoved: 0,
    globalPagesAnnotated: 0,
    legacyDirsRemoved: 0,
    indexRewritten: false,
    schemaRewritten: false,
  };

  // 1. Annotate existing flat global pages with frontmatter if missing.
  if (existsSync(PAGES_DIR)) {
    const entries = await readdir(PAGES_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = path.join(PAGES_DIR, entry);
      const st = await stat(full);
      if (!st.isFile()) continue;
      const body = await readFile(full, 'utf8');
      if (hasFrontmatter(body)) continue;
      const summary = extractFirstNonHeadingLine(body);
      const fm = buildFrontmatter({
        appliesTo: ['global'],
        topics: [],
        related: [],
        summary,
      });
      await writeFile(full, fm + body, 'utf8');
      report.globalPagesAnnotated++;
    }
  }

  // 2. Move project-tier pages out into the flat pages dir with
  //    `applies_to: [<projectSlug>]` frontmatter.
  if (existsSync(LEGACY_PROJECTS_DIR)) {
    const all = loadAllProjects();
    const projectDirs = await readdir(LEGACY_PROJECTS_DIR);
    for (const dirName of projectDirs) {
      const dirPath = path.join(LEGACY_PROJECTS_DIR, dirName);
      const dirStat = await stat(dirPath).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) continue;

      // Resolve slug. The dir name is either a pinloom projectId (legacy)
      // or already a slug (e.g. from an aborted PR-#28 era branch).
      const matchById = all.find((p) => p.id === dirName);
      const slug = matchById ? computeWikiSlug(matchById.id, matchById.cwd, all) : dirName;

      const legacyPagesDir = path.join(dirPath, 'pages');
      if (existsSync(legacyPagesDir)) {
        const entries = await readdir(legacyPagesDir);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;
          const src = path.join(legacyPagesDir, entry);
          const st = await stat(src).catch(() => null);
          if (!st || !st.isFile()) continue;

          const baseName = entry.replace(/\.md$/, '');
          const targetName = baseName.endsWith(`-${slug}`)
            ? entry
            : `${baseName}-${slug}.md`;
          const target = path.join(PAGES_DIR, targetName);

          const body = await readFile(src, 'utf8');
          let newBody = body;
          if (!hasFrontmatter(body)) {
            const summary = extractFirstNonHeadingLine(body);
            newBody =
              buildFrontmatter({
                appliesTo: [slug],
                topics: [],
                related: [],
                summary,
              }) + body;
          }

          if (existsSync(target)) {
            // Already migrated — drop the source. The sync agent will
            // reconcile any divergence on its next run.
            await rm(src, { force: true });
          } else {
            await writeFile(target, newBody, 'utf8');
            await rm(src, { force: true });
          }
          report.projectPagesMoved++;
        }
      }

      // Drop the now-redundant project subtree (index.md, _schema.md, pages/).
      await rm(dirPath, { recursive: true, force: true });
      report.legacyDirsRemoved++;
    }

    // Best-effort cleanup of the empty `projects/` dir itself.
    try {
      const remaining = await readdir(LEGACY_PROJECTS_DIR);
      if (remaining.length === 0) {
        await rm(LEGACY_PROJECTS_DIR, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  return report;
}

async function readWikiPagesFlat(): Promise<
  { name: string; body: string; relPath: string }[]
> {
  if (!existsSync(PAGES_DIR)) return [];
  const out: { name: string; body: string; relPath: string }[] = [];
  const entries = await readdir(PAGES_DIR);
  for (const entry of entries) {
    const full = path.join(PAGES_DIR, entry);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      // Promoted topic directory — read its index.md as the entry point.
      const inner = path.join(full, 'index.md');
      if (existsSync(inner)) {
        const body = await readFile(inner, 'utf8');
        out.push({ name: `${entry}/index.md`, body, relPath: `${entry}/index.md` });
      }
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    const body = await readFile(full, 'utf8');
    out.push({ name: entry, body, relPath: entry });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function readWikiSnapshot(): Promise<string> {
  const parts: string[] = [];

  if (existsSync(SCHEMA_FILE)) {
    parts.push(`### ~/.pinloom/wiki/_schema.md\n\n${await readFile(SCHEMA_FILE, 'utf8')}`);
  }
  if (existsSync(INDEX_FILE)) {
    parts.push(`### ~/.pinloom/wiki/index.md\n\n${await readFile(INDEX_FILE, 'utf8')}`);
  }

  const pages = await readWikiPagesFlat();
  for (const p of pages) {
    parts.push(`### ~/.pinloom/wiki/pages/${p.relPath}\n\n${p.body}`);
  }

  return parts.length === 0 ? '_(wiki is empty)_' : parts.join('\n\n---\n\n');
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

function buildSyncSystemPrompt(scopes: ProjectScope[]): string {
  const active = scopes.find((s) => s.isActive);
  if (!active) throw new Error('no active project scope');
  const others = scopes.filter((s) => !s.isActive);

  const projectsTable = [active, ...others]
    .map((s) => {
      const tag = s.isActive ? ' (ACTIVE — default scope)' : '';
      return `- \`${s.slug}\`${tag} — ${s.name ?? '(unnamed)'} (cwd: \`${s.cwd}\`)`;
    })
    .join('\n');

  return `You maintain the user's personal knowledge wiki at \`~/.pinloom/wiki/\`.

## Layout

- \`pages/\` — flat directory of every page. Each page has YAML
  frontmatter declaring scope.
- \`index.md\` — auto-maintained list of every page, grouped by topic.
- \`_schema.md\` — user-editable conventions; read it once at the
  start of your run.

## Active session

The user is in a session for project \`${active.slug}\` (${active.name ?? '(unnamed)'}, cwd \`${active.cwd}\`). Treat this as the **default scope** for new
insights from the conversation.

## All registered projects (valid \`applies_to\` slugs)

${projectsTable}

\`global\` is also a valid \`applies_to\` value, meaning "applies to all
sessions regardless of project."

## Your job

1. Read \`_schema.md\` once for conventions.
2. Read \`index.md\` to see what pages already exist.
3. For each insight extracted from the conversation snippet below:
   a. **Decide scope** — which projects does this apply to?
      - Specific to active project → \`applies_to: [${active.slug}]\`
      - Specific to another listed project → \`applies_to: [<thatSlug>]\`
      - Cross-project / general → \`applies_to: [global]\`
      - Multi-project → list all relevant slugs
      Default to the active project when in doubt. Only route to
      another project when the conversation explicitly discussed that
      project's repo or rules.
   b. **Decide topic tags** — free-form, kebab-friendly. Reuse tags
      already in use across existing pages when applicable. Look at
      existing frontmatter before inventing a new tag.
   c. **Pick filename** —
      - Project-specific: suffix with project slug
        (e.g. \`git-conventions-${active.slug}.md\`)
      - Cross-project: generic kebab-case
        (e.g. \`react-hooks-patterns.md\`)
   d. **Write or update the page** in \`pages/\`. If a similar page
      exists, prefer updating it over creating a duplicate. Set
      \`related\` to other pages explicitly connected to this one.
      Provide a 1-line \`summary\`.

4. After all page writes, update \`index.md\`:
   - **Only inside** the ${AUTO_SECTION_OPEN} ... ${AUTO_SECTION_CLOSE}
     markers. Anything outside is user-owned.
   - List every page in \`pages/\` (or its promoted directory entry).
   - Group pages into sections by their primary \`topic\`. Use H2 (\`##\`)
     headings for groups; "Misc" for pages without topic tags.
   - Each entry format:
     \`- [<filename>](./pages/<filename>) \\\`[applies_to]\\\` \\\`topic1, topic2\\\` — summary\`

## What to skip

- Transient working state (a bug being actively debugged but not solved)
- Trivial details (file paths, one-off command output)
- Information already captured well in existing pages — only update if new
- Anything that doesn't yield durable, reusable knowledge

## Reading-agent protections

The runner agent (the one that reads the wiki during normal sessions)
filters pages by matching \`applies_to\` against the active project's
slug. **Choose \`applies_to\` carefully** — a wrong slug means a rule
will leak into projects it shouldn't apply to, or stay invisible
where it should.

## When done

Briefly summarize:
- Pages created or updated, and the \`applies_to\` you assigned to each.
- Any page that you considered creating but skipped (and why).
- No preamble.`;
}

interface SyncResult {
  output: string;
  lastSyncedMessageId: string | null;
  messageCount: number;
  migration?: MigrationReport;
}

export async function runWikiSync(args: {
  sessionId: string;
  model?: string;
}): Promise<SyncResult> {
  const { sessionId, model = DEFAULT_SYNC_MODEL } = args;

  await ensureWikiLayout();
  const migration = await migrateLegacyLayout();

  const ctx = loadSessionContext(sessionId);
  const allProjects = loadAllProjects();
  const scopes = buildProjectScopes(ctx.projectId, allProjects);

  const { messages, lastMessageId } = loadMessagesSinceSync(
    sessionId,
    ctx.lastSyncedMessageId,
  );
  if (messages.length === 0) {
    return {
      output: 'No new messages since last sync. Wiki is up to date.',
      lastSyncedMessageId: null,
      messageCount: 0,
      migration,
    };
  }

  const filtered = filterMessages(messages);
  if (filtered.length === 0) {
    return {
      output: 'New messages contained no syncable content.',
      lastSyncedMessageId: lastMessageId,
      messageCount: messages.length,
      migration,
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
    migration,
  };
}

// Exported so the legacy `rename`/migration tests can be added later if needed.
export const _internal = {
  computeWikiSlug,
  hasFrontmatter,
  buildFrontmatter,
  migrateLegacyLayout,
};
