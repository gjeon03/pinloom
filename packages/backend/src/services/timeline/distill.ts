// Timeline distillation (docs/knowledge-system-v3.md §12, 2B). Turns a day's
// session activity + that project's git commits into the markdown work-journal
// entry for one project-day. The LLM call is behind an injectable `RunDistill`
// seam (mirrors wiki-gardener.ts) so prompt assembly + git parsing are unit-
// testable without auth. ONE entrypoint shared by the idle sweep, the daily
// roll-up, and manual "정리해줘".

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';

const execFileP = promisify(execFile);

const DEFAULT_DISTILL_MODEL = 'claude-sonnet-4-6';
const DISTILL_TIMEOUT_MS = 5 * 60_000;
// Bound how much transcript we feed the model.
const SNAPSHOT_CHAR_BUDGET = 100_000;
const MAX_COMMITS = 200;

export interface CommitInfo {
  hash: string;
  date: string;
  subject: string;
}

// Parse `git log --pretty=format:%h%x09%cd%x09%s` (tab-separated) output.
export function parseGitLog(stdout: string): CommitInfo[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const [hash, date, ...rest] = line.split('\t');
      return { hash, date, subject: rest.join('\t') };
    });
}

/**
 * Commits authored on a given LOCAL date for the repo at `cwd`. Uses execFile
 * (no shell — the date can't inject), local-tz day boundaries, and a non-repo
 * guard. Never throws: a non-repo / git error yields [].
 */
export async function gitCommitsForDay(cwd: string, date: string): Promise<CommitInfo[]> {
  try {
    await execFileP('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return []; // not a git repo (or git missing)
  }
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      cwd,
      'log',
      `--since=${date} 00:00:00`,
      `--until=${date} 23:59:59`,
      '--date=local',
      '--no-merges',
      `-n`,
      String(MAX_COMMITS),
      '--pretty=format:%h%x09%cd%x09%s',
    ]);
    return parseGitLog(stdout);
  } catch {
    return [];
  }
}

export interface DistillSession {
  id: string;
  title: string | null;
  transcript: string;
}

export interface DistillInput {
  projectName: string;
  date: string; // YYYY-MM-DD (local)
  sessions: DistillSession[];
  commits: CommitInfo[];
  /** The existing entry for this day, if any (incremental update). */
  existingEntry: string | null;
}

// prompt -> markdown entry. Injectable for tests.
export type RunDistill = (prompt: string, model: string) => Promise<string>;

export const DISTILL_SYSTEM_PROMPT = `You maintain a developer's personal WORK JOURNAL. Given one day's AI coding-session transcripts and that project's git commits, write a concise dated entry capturing WHAT was done and—crucially—WHY (the reasoning, decisions, and discarded options visible in the conversation). The git commits are the WHAT; the conversation is the WHY. Join them.

Output ONLY the markdown for this one day's entry (no code fences, no preamble). Structure:

# <date> — <project>

## 한 일 (What)
- concise bullets of what was built/changed/decided; reference commits by short hash where relevant.

## 왜 / 결정 (Why)
- the reasoning, trade-offs, and decisions behind the work — the part git can't capture.

## 커밋
- <hash> <subject>  (list the day's commits, or "(없음)")

Rules:
- Korean by default. Be factual and grounded ONLY in the provided transcripts/commits — never invent outcomes.
- **NEVER reproduce the raw transcript.** Do NOT copy [user]/[assistant]/[tool] tagged lines, tool outputs, command logs, code blocks, file paths dumps, or pasted skill/instruction text. SUMMARIZE everything in your own words. Your entire output is the structured entry above and nothing else — if you find yourself quoting transcript lines, stop and summarize instead.
- If an existing entry is provided, UPDATE it: merge new work into the existing sections, keep prior content, don't duplicate. Return the full updated entry — but still only the clean structured summary, never raw logs.
- Keep it tight — a journal entry, not an essay. A day should be at most a few dozen lines.`;

function buildPrompt(input: DistillInput): string {
  const parts: string[] = [
    `Date: ${input.date}`,
    `Project: ${input.projectName}`,
    '',
  ];
  if (input.existingEntry) {
    // Cap so a previously-ballooned entry can't feed its bloat back in.
    const existing =
      input.existingEntry.length > 8000
        ? `${input.existingEntry.slice(0, 8000)}\n…(생략)`
        : input.existingEntry;
    parts.push('## Existing entry (update this):', existing, '');
  }
  parts.push('## Git commits this day:');
  parts.push(
    input.commits.length > 0
      ? input.commits.map((c) => `- ${c.hash} ${c.subject}`).join('\n')
      : '(none)',
  );
  parts.push('', '## Session transcripts this day:');
  let budget = SNAPSHOT_CHAR_BUDGET;
  for (const s of input.sessions) {
    if (budget <= 0) break;
    const block = `### Session ${s.id}${s.title ? ` "${s.title}"` : ''}\n${s.transcript}`;
    parts.push(block.slice(0, Math.max(budget, 0)));
    budget -= block.length;
  }
  return parts.join('\n');
}

// Real SDK distill: a single bounded text generation, no tools (everything it
// needs is in the prompt). Mirrors wiki-gardener's defaultRunAgent shape.
const defaultRunDistill: RunDistill = async (prompt, model) => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DISTILL_TIMEOUT_MS);
  const q = query({
    prompt,
    options: {
      systemPrompt: DISTILL_SYSTEM_PROMPT,
      model,
      // 2, not 1: a single-turn cap fails with "reached maximum number of turns
      // (1)" whenever the model spends its only turn on a thinking block or a
      // (denied) tool attempt before emitting the summary text. allowedTools is
      // empty so there is no tool loop to run away — the extra turn just lets the
      // model finalize. Still bounded by DISTILL_TIMEOUT_MS.
      maxTurns: 2,
      permissionMode: 'bypassPermissions',
      allowedTools: [],
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
        if (m.result.length > out.length) out = m.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
};

/** Distill (or incrementally update) one project-day's journal entry. */
export async function distillDay(
  input: DistillInput,
  opts: { runDistill?: RunDistill; model?: string } = {},
): Promise<string> {
  const run = opts.runDistill ?? defaultRunDistill;
  const md = (await run(buildPrompt(input), opts.model ?? DEFAULT_DISTILL_MODEL)).trim();
  return md ? `${md}\n` : '';
}
