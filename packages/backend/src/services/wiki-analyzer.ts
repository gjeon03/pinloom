import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { getPagesDir } from './wiki-reader.js';

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

Your **final response** must be ONLY the markdown body of the wiki page.
No preamble, no explanation, no code-fence wrapping the whole document.

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

export function isAnalyzing(projectId: string): boolean {
  return activeAnalyses.has(projectId);
}

export async function runConventionsAnalysis(
  projectId: string,
  options?: { model?: string },
): Promise<AnalyzeResult> {
  if (activeAnalyses.has(projectId)) {
    throw new Error('analysis already in progress for this project');
  }

  const db = getDb();
  const project = db
    .prepare('SELECT id, name, cwd FROM projects WHERE id = ?')
    .get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`project ${projectId} not found`);

  if (!existsSync(project.cwd)) {
    throw new Error(`project cwd does not exist: ${project.cwd}`);
  }

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
    projectCwd: project.cwd,
    projectSlug: slug,
    existingPageContent,
  });

  const initialPrompt = `Analyze the project at \`${project.cwd}\` for conventions. Return the markdown body of the wiki page only.`;

  const abortController = new AbortController();
  activeAnalyses.set(projectId, abortController);

  try {
    const q = query({
      prompt: initialPrompt,
      options: {
        cwd: project.cwd,
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
      return {
        output: 'Analysis returned no content; nothing was written.',
        pageFile,
        pageRelPath,
        pageWritten: false,
        charCount: 0,
      };
    }

    body = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const fenceMatch = body.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) body = fenceMatch[1];
    body = body.trim();

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

    await writeFile(pageFile, frontmatter + body + '\n', 'utf8');

    return {
      output: `Wrote ${pageRelPath} (${body.length} chars). ${summary}`,
      pageFile,
      pageRelPath,
      pageWritten: true,
      charCount: body.length,
    };
  } finally {
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
