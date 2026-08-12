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

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  parseJsonlLine,
  parseJsonlLines,
  SYNTHETIC_MODEL,
  type JsonlLine,
} from '../claude-jsonl/index.js';

const CHECKPOINT_CHUNK_SIZE = 1 << 20;

export interface ClaudeTranscriptCheckpoint {
  uuid: string | null;
  completeOffset: number;
  transcriptIdentity: string;
  lastConversationType: 'user' | 'assistant' | null;
}

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
  opts: { timeoutMs?: number; pollMs?: number; home?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('aborted');
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

function isMeaningfulConversationLine(line: JsonlLine): line is JsonlLine & {
  type: 'user' | 'assistant';
} {
  return (
    (line.type === 'user' || line.type === 'assistant') &&
    !line.isSidechain &&
    line.message?.model !== SYNTHETIC_MODEL
  );
}

/**
 * Find a restart checkpoint without loading the entire transcript. Only
 * newline-terminated records are considered, leaving a concurrently written
 * trailing JSON fragment outside the durable cursor.
 */
export function readCheckpoint(file: string): ClaudeTranscriptCheckpoint | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }

  try {
    const stat = fstatSync(fd);
    const transcriptIdentity = `${stat.dev}:${stat.ino}`;
    const chunk = Buffer.allocUnsafe(CHECKPOINT_CHUNK_SIZE);
    let position = stat.size;
    let pending = Buffer.alloc(0);
    let completeOffset: number | null = null;
    let uuid: string | null = null;
    let lastConversationType: 'user' | 'assistant' | null = null;

    while (position > 0 && (uuid === null || lastConversationType === null || completeOffset === null)) {
      const start = Math.max(0, position - CHECKPOINT_CHUNK_SIZE);
      const requested = position - start;
      const count = readSync(fd, chunk, 0, requested, start);
      if (count !== requested) return null;

      const bytes = Buffer.concat([chunk.subarray(0, count), pending]);
      const bytesStart = start;
      let end = bytes.length;
      if (completeOffset === null) {
        const trailingNewline = bytes.lastIndexOf(0x0a);
        if (trailingNewline < 0) {
          position = start;
          continue;
        }
        completeOffset = bytesStart + trailingNewline + 1;
        end = trailingNewline + 1;
      }

      while (end > 0 && (uuid === null || lastConversationType === null)) {
        const previousNewline = end > 1 ? bytes.lastIndexOf(0x0a, end - 2) : -1;
        if (previousNewline < 0 && bytesStart !== 0) break;
        const recordStart = previousNewline + 1;
        const record = bytes.subarray(recordStart, end - 1);
        const parsed = parseJsonlLine(record.toString('utf8'));
        if (parsed) {
          if (uuid === null && typeof parsed.uuid === 'string' && parsed.uuid.length > 0) {
            uuid = parsed.uuid;
          }
          if (lastConversationType === null && isMeaningfulConversationLine(parsed)) {
            lastConversationType = parsed.type;
          }
        }
        end = previousNewline + 1;
      }

      pending = bytes.subarray(0, end);
      position = start;
    }

    return {
      uuid,
      completeOffset: completeOffset ?? 0,
      transcriptIdentity,
      lastConversationType,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
