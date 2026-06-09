// Locating and reading Claude Code's session transcript on disk. The CLI writes
// one JSONL file per session at:
//
//   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
//
// where <cwd-slug> is the absolute cwd with every non-alphanumeric run replaced
// by '-' (verified against real dirs, e.g.
// /Users/x/Documents_LOCAL/pinloom -> -Users-x-Documents-LOCAL-pinloom).
//
// This module is the ONLY fs surface the PTY transport touches for transcripts;
// the parser (../claude-jsonl) stays pure. Schema is owned by the CLI and can
// shift across versions — every read is defensive (missing file/dir => empty).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseJsonlLines, type JsonlLine } from '../claude-jsonl/index.js';

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectDir(cwd: string, home = homedir()): string {
  return path.join(home, '.claude', 'projects', projectSlug(cwd));
}

export function sessionFilePath(cwd: string, sessionId: string, home = homedir()): string {
  return path.join(projectDir(cwd, home), `${sessionId}.jsonl`);
}

export function sessionIdOf(file: string): string {
  return path.basename(file, '.jsonl');
}

/** Absolute paths of every session transcript currently in the project dir. */
export function listSessionFiles(cwd: string, home = homedir()): Set<string> {
  const dir = projectDir(cwd, home);
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f)),
    );
  } catch {
    return new Set();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll the project dir until a transcript file appears that wasn't in `before`
 * — that's the file the freshly-spawned `claude` just created. Returns its path.
 * Throws if none shows up within `timeoutMs` (claude failed to launch / wrong
 * cwd slug).
 */
export async function discoverNewSessionFile(
  cwd: string,
  before: ReadonlySet<string>,
  opts: { timeoutMs?: number; pollMs?: number; home?: string } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = [...listSessionFiles(cwd, opts.home)].filter((f) => !before.has(f));
    if (fresh.length === 1) return fresh[0];
    if (fresh.length > 1) {
      // Another claude process (a second pinloom session, or a `claude` the user
      // ran in the terminal panel) created a transcript in the same project slug
      // dir during our window — we can't tell which is ours. Refuse to guess.
      throw new Error(
        `ambiguous claude session: ${fresh.length} new transcripts appeared in ` +
          `${projectDir(cwd, opts.home)} (concurrent claude in the same project?)`,
      );
    }
    await sleep(pollMs);
  }
  throw new Error(
    `claude session transcript did not appear in ${projectDir(cwd, opts.home)} ` +
      `within ${timeoutMs}ms (did claude launch? is the cwd slug correct?)`,
  );
}

/** Parse the whole transcript; missing/unreadable file => []. */
export function readLines(file: string): JsonlLine[] {
  if (!existsSync(file)) return [];
  try {
    return parseJsonlLines(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The uuid of the last line that has one — the checkpoint to diff the next turn
 * against. null for a missing/empty/fresh transcript.
 */
export function readCheckpoint(file: string): string | null {
  const lines = readLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const u = lines[i].uuid;
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return null;
}
