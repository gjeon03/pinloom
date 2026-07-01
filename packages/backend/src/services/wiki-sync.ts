import {
  copyFile,
  mkdir,
  mkdtemp,
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

## What to capture

Capture durable, reusable knowledge of BOTH kinds — technical AND domain.
Don't default to only technical facts.

- **Technical** — conventions, architecture, patterns, gotchas, build/test/
  deploy facts, config, dependencies, integration wiring.
- **Domain & product knowledge** — the highest-value and easiest-to-lose kind,
  because it lives ONLY in conversation, never in the code:
  - **Glossary / terminology** — domain terms, entities, acronyms, and what
    they mean in this project.
  - **Business rules & constraints** — invariants, validation rules, edge
    cases, "must / must never" facts, why a limit exists.
  - **Product / user concepts** — who the users are, what the product does,
    the key workflows and the reasoning behind them.
  - **Domain decisions & rationale** — a choice made for a business/domain
    (not purely technical) reason, and WHY.
  - **External systems & integrations** — third-party services, upstream/
    downstream systems, their contracts and quirks.
  - **Assumptions & open questions** — stated assumptions and known unknowns.

If the conversation explains a domain fact — a term, a rule, why the business
works a certain way — CAPTURE IT. That is precisely the knowledge lost
otherwise. Prefer domain-oriented filenames when apt (e.g.
\`domain-glossary-${active.slug}.md\`, \`billing-rules-${active.slug}.md\`,
\`${active.slug}-product-concepts.md\`).

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

// Global serialization — only one wiki sync may run at a time. The wiki
// lives in a single shared `pages/` tree, and the sync agent reads +
// writes the directory plus `index.md` as a transaction. Two concurrent
// agents would race on snapshot/index updates and last-write-wins on
// overlapping pages.
//
// We queue rather than reject: each runWikiSync() call attaches to a
// Promise chain and resolves with its own result when its turn comes up.
// The HTTP request just stays open longer if there's a queue ahead of it.
//
// Same-session dedup: if a request for the same session is already
// running or queued, return the existing in-flight Promise so the second
// click is idempotent rather than enqueueing a duplicate.

let syncChain: Promise<unknown> = Promise.resolve();
const pendingBySession = new Map<string, Promise<SyncResult>>();

export interface SyncQueueState {
  active: { sessionId: string; startedAt: string } | null;
  queuedSessionIds: string[];
}

let queueState: SyncQueueState = { active: null, queuedSessionIds: [] };

export function getSyncQueueState(): SyncQueueState {
  return {
    active: queueState.active ? { ...queueState.active } : null,
    queuedSessionIds: [...queueState.queuedSessionIds],
  };
}

// Run `fn` exclusively on the shared wiki write chain, so a gardener
// proposal-apply never races a concurrent session sync (or another apply) —
// both mutate ~/.pinloom/wiki/pages + index.md. Mirrors how runWikiSync
// serializes onto syncChain.
export function runOnWikiChain<T>(fn: () => Promise<T>): Promise<T> {
  const ourTurn = syncChain.then(fn, fn);
  syncChain = ourTurn.then(
    () => undefined,
    () => undefined,
  );
  return ourTurn;
}

export async function runWikiSync(args: {
  sessionId: string;
  model?: string;
}): Promise<SyncResult> {
  const { sessionId, model = DEFAULT_SYNC_MODEL } = args;

  const existing = pendingBySession.get(sessionId);
  if (existing) return existing;

  queueState = {
    ...queueState,
    queuedSessionIds: [...queueState.queuedSessionIds, sessionId],
  };

  const ourTurn = syncChain.then(async () => {
    queueState = {
      active: { sessionId, startedAt: new Date().toISOString() },
      queuedSessionIds: queueState.queuedSessionIds.filter((id) => id !== sessionId),
    };
    try {
      return await runWikiSyncInner({ sessionId, model });
    } finally {
      if (queueState.active?.sessionId === sessionId) {
        queueState = { ...queueState, active: null };
      }
    }
  });

  // Keep the chain alive even if our turn throws.
  syncChain = ourTurn.catch(() => undefined);

  pendingBySession.set(sessionId, ourTurn);
  ourTurn.finally(() => {
    if (pendingBySession.get(sessionId) === ourTurn) {
      pendingBySession.delete(sessionId);
    }
  });

  return ourTurn;
}

async function runWikiSyncInner(args: {
  sessionId: string;
  model: string;
}): Promise<SyncResult> {
  const { sessionId, model } = args;

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

// ─── Sandboxed sync → changeset (proposal-preview path) ───
//
// The manual "Sync" button used to run the distill agent directly against the
// real wiki (runWikiSyncInner). The proposal-preview flow instead runs the SAME
// agent inside a throwaway tempdir copy of the wiki, diffs the result against a
// baseline snapshot, and returns a changeset the route stages as reviewable
// proposals. Nothing in the real wiki is touched here, and the session's synced
// cursor is NOT advanced (that happens on accept).

const SANDBOX_TIMEOUT_MS = 8 * 60_000; // abort a hung sandbox distill after 8 min

export interface PageChange {
  relPath: string;
  before: string | null;
  after: string | null;
  op: 'replace' | 'archive';
}

// HARD sandbox containment (exported for tests). The sync agent runs
// bypassPermissions with a system prompt that still names the real wiki root
// (`~/.pinloom/wiki/`), so without this an absolute-path Write/Edit would escape
// the sandbox tempdir and mutate the LIVE wiki — silently defeating the whole
// preview gate. Deny any file mutation resolving outside tmpRoot; reads
// (Read/Glob/Grep) are unrestricted.
export function sandboxWriteGuard(
  tmpRoot: string,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const fp = (input.file_path ?? input.path ?? input.notebook_path) as unknown;
    if (typeof fp === 'string') {
      const rel = path.relative(tmpRoot, path.resolve(tmpRoot, fp));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          behavior: 'deny',
          message: `Refused: ${toolName} outside the wiki sandbox. Write only to relative paths under pages/ in your working directory.`,
        };
      }
    }
  }
  return { behavior: 'allow' };
}

const CONVENTIONS_PAGE_RE = /^conventions-.*\.md$/;

// Pure diff/filter step (exported for unit tests). `baseline` is the original
// bytes of every page that existed before the agent run; `current` is the bytes
// of every page present after. Produces the reviewable changeset:
//   - changed bytes  → replace
//   - baseline page gone in current → archive
//   - new file in current (not in baseline) → replace (creation)
// Filters out: conventions-*.md (owned by the conventions auto-wiki), no-ops,
// and never includes index.md / _schema.md (callers must not pass those keys,
// but we guard anyway).
export function computeChangeset(
  baseline: Map<string, string>,
  current: Map<string, string>,
): PageChange[] {
  const out: PageChange[] = [];
  const skip = (rel: string): boolean =>
    rel === 'index.md' ||
    rel === '_schema.md' ||
    CONVENTIONS_PAGE_RE.test(rel);

  // Replaces + creations (everything currently present).
  for (const [rel, after] of current) {
    if (skip(rel)) continue;
    const before = baseline.has(rel) ? baseline.get(rel)! : null;
    if (before === after) continue; // no-op
    out.push({ relPath: rel, before, after, op: 'replace' });
  }
  // Archives (baseline pages no longer present).
  for (const [rel, before] of baseline) {
    if (skip(rel)) continue;
    if (current.has(rel)) continue;
    out.push({ relPath: rel, before, after: null, op: 'archive' });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// Recursively collect every page under <dir>/pages into a Map<relPath, bytes>.
// Mirrors readWikiPagesFlat's flat + promoted-dir handling but against an
// arbitrary pages directory (the real one or the sandbox copy).
async function readPagesMap(pagesDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(pagesDir)) return out;
  const entries = await readdir(pagesDir);
  for (const entry of entries) {
    const full = path.join(pagesDir, entry);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const inner = path.join(full, 'index.md');
      if (existsSync(inner)) {
        out.set(`${entry}/index.md`, await readFile(inner, 'utf8'));
      }
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    out.set(entry, await readFile(full, 'utf8'));
  }
  return out;
}

// Recursively copy a pages directory into <destPagesDir>, preserving the
// flat-file / promoted-dir layout. Returns the baseline Map of original bytes.
async function copyPagesInto(
  srcPagesDir: string,
  destPagesDir: string,
): Promise<Map<string, string>> {
  await mkdir(destPagesDir, { recursive: true });
  const baseline = new Map<string, string>();
  if (!existsSync(srcPagesDir)) return baseline;
  const entries = await readdir(srcPagesDir);
  for (const entry of entries) {
    const srcFull = path.join(srcPagesDir, entry);
    const st = await stat(srcFull).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const inner = path.join(srcFull, 'index.md');
      if (existsSync(inner)) {
        const body = await readFile(inner, 'utf8');
        await mkdir(path.join(destPagesDir, entry), { recursive: true });
        await writeFile(path.join(destPagesDir, entry, 'index.md'), body, 'utf8');
        baseline.set(`${entry}/index.md`, body);
      }
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    const body = await readFile(srcFull, 'utf8');
    await writeFile(path.join(destPagesDir, entry), body, 'utf8');
    baseline.set(entry, body);
  }
  return baseline;
}

// Build a ROOT-RELATIVE wiki snapshot from a sandbox dir (mirrors
// readWikiSnapshot but with `### pages/<rel>` / `### index.md` / `### _schema.md`
// headers — no absolute `~/.pinloom/wiki/` prefix, since the agent's cwd is the
// sandbox root).
async function readSandboxSnapshot(tmpRoot: string): Promise<string> {
  const parts: string[] = [];
  const schemaFile = path.join(tmpRoot, '_schema.md');
  const indexFile = path.join(tmpRoot, 'index.md');
  if (existsSync(schemaFile)) {
    parts.push(`### _schema.md\n\n${await readFile(schemaFile, 'utf8')}`);
  }
  if (existsSync(indexFile)) {
    parts.push(`### index.md\n\n${await readFile(indexFile, 'utf8')}`);
  }
  const pagesMap = await readPagesMap(path.join(tmpRoot, 'pages'));
  const rels = [...pagesMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const rel of rels) {
    parts.push(`### pages/${rel}\n\n${pagesMap.get(rel)!}`);
  }
  return parts.length === 0 ? '_(wiki is empty)_' : parts.join('\n\n---\n\n');
}

export async function runSandboxedSync(args: {
  sessionId: string;
  model?: string;
}): Promise<{
  changeset: PageChange[];
  syncedThroughMessageId: string | null;
  messageCount: number;
}> {
  const { sessionId, model = DEFAULT_SYNC_MODEL } = args;

  const ctx = loadSessionContext(sessionId);
  const allProjects = loadAllProjects();
  const scopes = buildProjectScopes(ctx.projectId, allProjects);

  const { messages, lastMessageId } = loadMessagesSinceSync(
    sessionId,
    ctx.lastSyncedMessageId,
  );
  if (messages.length === 0) {
    return { changeset: [], syncedThroughMessageId: null, messageCount: 0 };
  }

  const filtered = filterMessages(messages);
  if (filtered.length === 0) {
    return {
      changeset: [],
      syncedThroughMessageId: lastMessageId,
      messageCount: messages.length,
    };
  }

  // Take a consistent snapshot of the real wiki INSIDE the chain (so a
  // concurrent sync/apply can't change the bytes mid-copy), but run the slow
  // agent OUTSIDE the chain.
  const { tmpRoot, baseline } = await runOnWikiChain(async () => {
    await ensureWikiLayout();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-sync-'));
    const bl = await copyPagesInto(PAGES_DIR, path.join(root, 'pages'));
    if (existsSync(INDEX_FILE)) {
      await copyFile(INDEX_FILE, path.join(root, 'index.md'));
    }
    if (existsSync(SCHEMA_FILE)) {
      await copyFile(SCHEMA_FILE, path.join(root, '_schema.md'));
    }
    return { tmpRoot: root, baseline: bl };
  });

  try {
    const wikiSnapshot = await readSandboxSnapshot(tmpRoot);
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
    const timeout = setTimeout(
      () => abortController.abort(),
      SANDBOX_TIMEOUT_MS,
    );
    const guardSandboxWrite = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> =>
      sandboxWriteGuard(tmpRoot, toolName, input);
    const sandboxAddendum =
      '\n\n## Sandbox (IMPORTANT)\nYour working directory IS the wiki root. Read and write ONLY relative paths (`pages/<name>.md`, `index.md`). Never use absolute paths like `~/.pinloom/wiki/...` — writes outside the working directory are rejected.';
    try {
      const q = query({
        prompt,
        options: {
          cwd: tmpRoot,
          systemPrompt: buildSyncSystemPrompt(scopes) + sandboxAddendum,
          model,
          maxTurns: 30,
          permissionMode: 'bypassPermissions',
          allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
          canUseTool: guardSandboxWrite,
          abortController,
        } as Parameters<typeof query>[0]['options'],
      });
      try {
        for await (const message of q) {
          if (abortController.signal.aborted) break;
          // We don't need the text result — the changeset is derived from the
          // resulting files on disk.
          void message;
        }
      } finally {
        try {
          const maybeClose = (q as unknown as { close?: () => void }).close;
          if (typeof maybeClose === 'function') maybeClose.call(q);
        } catch {
          // best-effort cleanup
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const current = await readPagesMap(path.join(tmpRoot, 'pages'));
    const changeset = computeChangeset(baseline, current);
    return {
      changeset,
      syncedThroughMessageId: lastMessageId,
      messageCount: messages.length,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Exported so the legacy `rename`/migration tests can be added later if needed.
export const _internal = {
  computeWikiSlug,
  hasFrontmatter,
  buildFrontmatter,
  migrateLegacyLayout,
};
