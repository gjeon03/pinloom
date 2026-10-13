import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId, runOnWikiChain } from './wiki-sync.js';
import { getPagesDir } from './wiki-reader.js';
import { createProposal } from './wiki-proposals.js';

interface ProjectRow {
  id: string;
  name: string | null;
  cwd: string;
}

export interface AnalyzeResult {
  output: string;
  pageFile: string;
  pageRelPath: string;
  pageWritten: boolean;
  charCount: number;
}

const DEFAULT_ANALYZE_MODEL = 'claude-sonnet-4-6';
const ANALYZE_TIMEOUT_MS = 8 * 60_000; // abort a hung analyze after 8 min

function buildConventionsSystemPrompt(args: {
  projectName: string | null;
  projectCwd: string;
  projectSlug: string;
  existingPageContent: string | null;
}): string {
  const { projectName, projectCwd, projectSlug, existingPageContent } = args;
  const baseLabel = projectName ?? projectSlug;
  return `You analyze a project's codebase to extract durable conventions
that the user's AI assistant should follow in future sessions on this project.

## Project context

- Name: ${baseLabel}
- Slug: ${projectSlug}
- Local path: ${projectCwd}

## Your task

Survey the project at the cwd above and produce a single markdown
document capturing its **conventions** — facts that help an AI working
on this project follow the team's established patterns.

Cover (only what's actually present):
- **Stack** — language(s), framework(s), build tool, package manager
- **Folder structure** — top-level directories and what they contain
  (1-2 sentences each)
- **Build / run / test commands** — from package.json scripts, Makefile, etc.
- **Linting / formatting** — what's configured (ESLint, Prettier, ruff,
  etc.) and unusual rules worth knowing
- **Testing** — framework, where tests live, how to run them; or "no tests"
- **Naming patterns** — observable file/folder/symbol naming rules
- **Notable dependencies** — only those that imply patterns
  (e.g., React Router → SPA routing, Zustand → state pattern)
- **Config conventions** — env var loading, secrets handling, anything
  that would surprise a newcomer

Skip:
- Listing every dependency (boring, low signal)
- Architectural deep-dives (a separate analyzer covers that)
- Speculation — only state what you can verify from files

## Constraints

- You are READ-ONLY. Allowed tools: Read, Glob, Grep, Bash.
- Use Bash ONLY for read-only inspection (\`ls\`, \`cat\`, \`tree\`,
  \`wc\`, \`find\`, \`head\`, \`tail\`). Never run state-changing commands,
  installers, builds, tests, or git mutations.
- Hard cap: at most ~50 file reads. Be selective — start with
  \`package.json\` / \`pyproject.toml\` / \`go.mod\` etc., the README,
  \`tsconfig.json\`, then sample 3-5 representative source files.

## Output format

Your **final response** is the markdown body. NOTHING ELSE.

- Do NOT prefix with any acknowledgment, status update, or meta-comment
  in any language ("Here's the analysis", "I'll now write the document",
  "Based on my findings…", or equivalents — none of these).
- Start IMMEDIATELY with the \`# <Project> conventions\` heading on the
  very first line.
- Do NOT wrap the whole response in a markdown code fence.
- Do NOT include any YAML frontmatter (\`---\` block) — the caller adds it.
- Write in the language the user works in: if a previous analysis is
  provided below, match its language; otherwise default to the language
  the project's README and source comments use.

Recommended structure:

\`\`\`
# ${baseLabel} conventions

A one-paragraph overview.

## Stack

- ...

## Folder structure

- \`src/\` — ...
- \`tests/\` — ...

## Build & run

\\\`\\\`\\\`bash
pnpm install
pnpm dev
\\\`\\\`\\\`

## Linting & formatting
...

## Testing
...

## Notable patterns
...
\`\`\`

The frontmatter (\`applies_to\`, \`topic\`, \`summary\`) will be added by
the caller — do NOT include any \`---\` block in your output.

${
  existingPageContent
    ? `## Previous analysis (context — feel free to update or replace)

\`\`\`
${existingPageContent}
\`\`\`

If most of the previous analysis is still accurate, you can keep
those sections. Only update what has changed in the codebase.`
    : ''
}`;
}

// Defensive cleanup of whatever the agent returned. The system prompt
// already forbids these patterns but agents occasionally slip in:
//   - leading status preamble ("I have gathered enough info…")
//   - YAML frontmatter (we add our own)
//   - whole-document code-fence wrapping
//   - dangling closing fence after we strip preamble
// Order matters here — strip frontmatter first, then unwrap full fences,
// then drop everything before the first H1, then mop up trailing fences.
function sanitizeAgentBody(input: string): string {
  let body = input;

  body = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');

  const fullFence = body.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fullFence) body = fullFence[1];

  const h1Idx = body.search(/^# /m);
  if (h1Idx > 0) body = body.slice(h1Idx);

  body = body.replace(/\n?```\s*$/, '');

  return body.trim();
}

function extractSummary(body: string, fallback: string): string {
  const lines = body.split('\n');
  let pastH1 = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!pastH1) {
      if (line.startsWith('# ')) pastH1 = true;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('-') || line.startsWith('*')) continue;
    if (line.startsWith('```')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return `${fallback} conventions`;
}

const activeAnalyses = new Map<string, AbortController>();
// At most this many conventions analyses run at once (manual + auto combined).
// Each is heavy (LLM agent + codebase scan + worktree); more would choke the server.
const MAX_CONCURRENT_ANALYSES = 2;

export function isAnalyzing(projectId: string): boolean {
  return activeAnalyses.has(projectId);
}

// Persistent (in-process) log of analyses so the frontend can rehydrate
// "running" state across page reloads. Reset on backend restart, which
// is fine because any in-flight agent dies with the process anyway.
export interface AnalysisLogEntry {
  projectId: string;
  projectName: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'error';
  detail?: string;
  pageRelPath?: string;
}

const ANALYSIS_LOG_LIMIT = 30;
const analysisLog: AnalysisLogEntry[] = [];

function pushLog(entry: AnalysisLogEntry): AnalysisLogEntry {
  analysisLog.unshift(entry);
  if (analysisLog.length > ANALYSIS_LOG_LIMIT) {
    analysisLog.length = ANALYSIS_LOG_LIMIT;
  }
  return entry;
}

export function getAnalysisStatus(): {
  running: AnalysisLogEntry[];
  recent: AnalysisLogEntry[];
} {
  return {
    running: analysisLog.filter((e) => e.status === 'running'),
    recent: analysisLog.slice(),
  };
}

const pexec = promisify(execFile);

interface AnalysisCwd {
  cwd: string;
  cleanup: () => Promise<void>;
}

/**
 * Resolve the directory to analyze for conventions. Conventions describe the
 * STABLE, shared codebase — so we analyze a detached git worktree of the
 * project's DEFAULT branch (main/master), not the currently checked-out branch
 * or uncommitted changes. Otherwise a mid-refactor feature branch (which may
 * never merge) would be captured as "the convention". Falls back to the project
 * cwd for non-git repos, a missing default branch, or any git failure — the
 * worktree is a correctness upgrade, never a hard requirement.
 */
export async function resolveAnalysisCwd(projectCwd: string): Promise<AnalysisCwd> {
  const asIs: AnalysisCwd = { cwd: projectCwd, cleanup: async () => {} };
  let tmp: string | null = null;
  try {
    await pexec('git', ['-C', projectCwd, 'rev-parse', '--is-inside-work-tree']);
    // Default branch: prefer the remote's HEAD, else a local main/master.
    let ref: string | null = null;
    try {
      const { stdout } = await pexec('git', [
        '-C', projectCwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
      ]);
      ref = stdout.trim() || null; // e.g. "origin/main"
    } catch {
      /* no origin/HEAD */
    }
    if (!ref) {
      for (const b of ['main', 'master']) {
        try {
          await pexec('git', ['-C', projectCwd, 'rev-parse', '--verify', b]);
          ref = b;
          break;
        } catch {
          /* branch absent */
        }
      }
    }
    if (!ref) return asIs; // no standard default branch → analyze cwd as-is
    tmp = await mkdtemp(path.join(os.tmpdir(), 'pinloom-conv-'));
    // --detach avoids "branch already checked out" when main is also the live worktree.
    await pexec('git', ['-C', projectCwd, 'worktree', 'add', '--detach', tmp, ref]);
    const worktree = tmp;
    return {
      cwd: worktree,
      cleanup: async () => {
        try {
          await pexec('git', ['-C', projectCwd, 'worktree', 'remove', '--force', worktree]);
        } catch {
          /* best-effort */
        }
        await rm(worktree, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return asIs; // not a git repo / git unavailable
  }
}

export async function runConventionsAnalysis(
  projectId: string,
  options?: { model?: string; startedAt?: string; stageProposal?: boolean },
): Promise<AnalyzeResult> {
  if (activeAnalyses.has(projectId)) {
    throw new Error('analysis already in progress for this project');
  }
  // Global concurrency cap: each analysis is a full LLM agent scanning the
  // codebase (+ a git worktree), so a burst of manual clicks across projects
  // could otherwise run N heavy agents at once and choke the server.
  if (activeAnalyses.size >= MAX_CONCURRENT_ANALYSES) {
    const err = new Error(
      `too many analyses running (max ${MAX_CONCURRENT_ANALYSES}) — wait for one to finish`,
    );
    (err as { code?: string }).code = 'ANALYSIS_BUSY';
    throw err;
  }

  const db = getDb();
  const project = db
    .prepare('SELECT id, name, cwd FROM projects WHERE id = ?')
    .get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`project ${projectId} not found`);

  if (!existsSync(project.cwd)) {
    throw new Error(`project cwd does not exist: ${project.cwd}`);
  }

  // Analyze the default-branch worktree (stable/merged code), not the live cwd.
  const analysis = await resolveAnalysisCwd(project.cwd);
  const analyzeCwd = analysis.cwd;

  const slug = getProjectWikiSlugByProjectId(projectId);
  const pagesDir = getPagesDir();
  await mkdir(pagesDir, { recursive: true });
  const pageRelPath = `conventions-${slug}.md`;
  const pageFile = path.join(pagesDir, pageRelPath);

  let existingPageContent: string | null = null;
  if (existsSync(pageFile)) {
    const existing = await readFile(pageFile, 'utf8');
    const fmStripped = existing.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    existingPageContent = fmStripped;
  }

  const systemPrompt = buildConventionsSystemPrompt({
    projectName: project.name,
    projectCwd: analyzeCwd,
    projectSlug: slug,
    existingPageContent,
  });

  const initialPrompt = `Analyze the project at \`${analyzeCwd}\` for conventions. Return the markdown body of the wiki page only.`;

  const abortController = new AbortController();
  activeAnalyses.set(projectId, abortController);
  // Hard ceiling so a hung agent can't pin `activeAnalyses` (and, for the auto
  // sweep, the single-flight `running` flag) forever.
  const analyzeTimeout = setTimeout(() => abortController.abort(), ANALYZE_TIMEOUT_MS);

  const logEntry = pushLog({
    projectId,
    projectName: project.name ?? slug,
    // Trust the caller's timestamp so the frontend can build a matching
    // deterministic notification id without a round-trip.
    startedAt: options?.startedAt ?? new Date().toISOString(),
    status: 'running',
  });

  try {
    const q = query({
      prompt: initialPrompt,
      options: {
        cwd: analyzeCwd,
        systemPrompt,
        model: options?.model ?? DEFAULT_ANALYZE_MODEL,
        maxTurns: 30,
        permissionMode: 'bypassPermissions',
        // Read-only toolset — no Write/Edit, so the agent cannot modify
        // the codebase. The system prompt forbids state-changing Bash.
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash(command:*)'],
        abortController,
        includePartialMessages: false,
      } as Parameters<typeof query>[0]['options'],
    });

    let body = '';
    try {
      for await (const message of q) {
        if (abortController.signal.aborted) break;
        const anyMsg = message as unknown as {
          type: string;
          message?: { content?: Array<{ type: string; text?: string }> };
          result?: string;
          subtype?: string;
        };
        if (anyMsg.type === 'assistant') {
          const content = anyMsg.message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              body = block.text;
            }
          }
        } else if (
          anyMsg.type === 'result' &&
          anyMsg.subtype === 'success' &&
          anyMsg.result
        ) {
          if (anyMsg.result.length > body.length) body = anyMsg.result;
        }
      }
    } finally {
      try {
        const maybeClose = (q as unknown as { close?: () => void }).close;
        if (typeof maybeClose === 'function') maybeClose.call(q);
      } catch {
        // ignore
      }
    }

    if (!body.trim()) {
      logEntry.status = 'success';
      logEntry.finishedAt = new Date().toISOString();
      logEntry.detail = 'Analysis returned no content; nothing was written.';
      return {
        output: logEntry.detail,
        pageFile,
        pageRelPath,
        pageWritten: false,
        charCount: 0,
      };
    }

    body = sanitizeAgentBody(body);

    const summary = extractSummary(body, project.name ?? slug);
    const frontmatter = [
      '---',
      `applies_to: [${slug}]`,
      'topic: [conventions]',
      'related: []',
      `summary: ${JSON.stringify(summary)}`,
      '---',
      '',
    ].join('\n');

    const fullPage = frontmatter + body + '\n';

    // Auto path: stage the regenerated page as a proposal for the user to
    // review/accept instead of writing it — the wiki is injected into every
    // system prompt, so auto-generated content must pass the human gate. Manual
    // (button) analysis keeps writing directly (the click IS the consent).
    if (options?.stageProposal) {
      await createProposal({
        kind: 'replace_page',
        title: `Auto: refresh conventions for ${project.name ?? slug}`,
        relPath: pageRelPath,
        payload: { markdown: fullPage },
      });
      const output = `Staged conventions proposal for ${pageRelPath} (${body.length} chars). ${summary}`;
      logEntry.status = 'success';
      logEntry.finishedAt = new Date().toISOString();
      logEntry.detail = output;
      logEntry.pageRelPath = pageRelPath;
      return { output, pageFile, pageRelPath, pageWritten: false, charCount: body.length };
    }

    // Serialize the direct write on the wiki chain — the same chain
    // acceptProposal uses — so a manual analyze can't race a proposal accept
    // (or a session sync) into a lost update on the conventions page.
    await runOnWikiChain(() => writeFile(pageFile, fullPage, 'utf8'));

    const output = `Wrote ${pageRelPath} (${body.length} chars). ${summary}`;
    logEntry.status = 'success';
    logEntry.finishedAt = new Date().toISOString();
    logEntry.detail = output;
    logEntry.pageRelPath = pageRelPath;

    return {
      output,
      pageFile,
      pageRelPath,
      pageWritten: true,
      charCount: body.length,
    };
  } catch (err) {
    logEntry.status = 'error';
    logEntry.finishedAt = new Date().toISOString();
    logEntry.detail = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    clearTimeout(analyzeTimeout);
    await analysis.cleanup(); // remove the temp default-branch worktree (no-op if cwd)
    if (activeAnalyses.get(projectId) === abortController) {
      activeAnalyses.delete(projectId);
    }
  }
}

export function cancelAnalysis(projectId: string): boolean {
  const controller = activeAnalyses.get(projectId);
  if (!controller) return false;
  controller.abort();
  activeAnalyses.delete(projectId);
  return true;
}

/** Abort every in-flight analysis (a stampede escape hatch). Returns the count. */
export function cancelAllAnalyses(): number {
  let n = 0;
  for (const [projectId, controller] of activeAnalyses) {
    controller.abort();
    activeAnalyses.delete(projectId);
    n += 1;
  }
  return n;
}
