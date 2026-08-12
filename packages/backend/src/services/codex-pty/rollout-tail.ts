// Incremental reader for a codex rollout, which is an append-only JSONL file.
//
// The capture loop used to call readRolloutLines() — readFileSync(utf8) + split
// + JSON.parse over the WHOLE file — on every 500ms tick. On a long session that
// is not a small constant: a 323MB rollout measured 845ms per tick (409ms read,
// 208ms split, 228ms parse, ~1GB of garbage), so ticks ran back-to-back and
// pinned a core. Because one backend process relays every session's pty, that
// starved keystroke echo and output streaming for all the others.
//
// Reading only the bytes appended since the last tick makes the cost
// proportional to what codex actually wrote, and an idle session costs a single
// stat(). It also sidesteps V8's ~536M character string cap, which a whole-file
// read was two thirds of the way to hitting — past it readFileSync throws and
// the old bare catch turned that into a silent, permanent capture stall.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  rolloutSessionId,
  type CodexRolloutLine,
} from '../codex-rollout/parse.js';

export interface RolloutDelta {
  /** Lines completed since `offset`, in file order. */
  lines: CodexRolloutLine[];
  /** Absolute byte offset just past each returned line's newline, 1:1 with `lines`. */
  lineEnds: number[];
  /** Byte offset to resume from (last consumed newline, or `offset` if none). */
  offset: number;
  /** Physical byte length observed while reading, or null when the file was unavailable. */
  fileSizeBytes: number | null;
  /** Stable identity of the open rollout generation (`device:inode`). */
  rolloutIdentity: string | null;
  /** Physical bytes read during this call, exposed for performance regression tests. */
  bytesRead: number;
  /** Unfinished non-noise bytes retained by the stateful reader. */
  pendingBytes: number;
  /**
   * The file is shorter than `offset` — it was truncated or replaced, so every
   * line index the caller holds is meaningless and it must reset to zero.
   */
  truncated: boolean;
}

type ScannerPhase =
  | 'root'
  | 'key'
  | 'colon'
  | 'value'
  | 'nested'
  | 'primitive'
  | 'comma'
  | 'done';

interface TopLevelTypeScanner {
  phase: ScannerPhase;
  depth: number;
  inString: boolean;
  escaped: boolean;
  stringRole: 'key' | 'value' | null;
  stringBytes: number[];
  currentKeyIsType: boolean;
  compacted: boolean;
}

interface PartialLine {
  chunks: Buffer[];
  length: number;
  skipCompacted: boolean;
  scanner: TopLevelTypeScanner;
}

export interface RolloutTailState {
  /** Physical position already read, including an unfinished line. */
  readPosition: number;
  /** Last newline fully consumed. */
  completeOffset: number;
  /** Identity of the open file generation. */
  rolloutIdentity: string | null;
  /** Initial offset, retained for cursor migration diagnostics. */
  startOffset: number;
  partial: PartialLine;
  readChunk: typeof readSync;
}

function createScanner(): TopLevelTypeScanner {
  return {
    phase: 'root',
    depth: 0,
    inString: false,
    escaped: false,
    stringRole: null,
    stringBytes: [],
    currentKeyIsType: false,
    compacted: false,
  };
}

function createPartialLine(): PartialLine {
  return {
    chunks: [],
    length: 0,
    skipCompacted: false,
    scanner: createScanner(),
  };
}

export function createRolloutTailState(
  offset = 0,
  dependencies: {
    readChunk?: typeof readSync;
    rolloutIdentity?: string | null;
  } = {},
): RolloutTailState {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  return {
    readPosition: safeOffset,
    completeOffset: safeOffset,
    rolloutIdentity: dependencies.rolloutIdentity ?? null,
    startOffset: safeOffset,
    partial: createPartialLine(),
    readChunk: dependencies.readChunk ?? readSync,
  };
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}

function capturedStringEquals(scanner: TopLevelTypeScanner, expected: string): boolean {
  if (scanner.stringBytes.length !== expected.length) return false;
  return scanner.stringBytes.every((byte, index) => byte === expected.charCodeAt(index));
}

/**
 * Inspect only JSON structure needed to identify a top-level `type` string.
 * Nested objects and string contents cannot trigger the compacted fast path.
 */
function scanTopLevelType(scanner: TopLevelTypeScanner, byte: number): void {
  if (scanner.compacted || scanner.phase === 'done') return;
  if (scanner.inString) {
    if (scanner.escaped) {
      scanner.escaped = false;
      if (scanner.stringRole && scanner.stringBytes.length <= 16) {
        scanner.stringBytes.push(byte);
      }
      return;
    }
    if (byte === 0x5c) {
      scanner.escaped = true;
      if (scanner.stringRole && scanner.stringBytes.length <= 16) {
        scanner.stringBytes.push(byte);
      }
      return;
    }
    if (byte !== 0x22) {
      if (scanner.stringRole && scanner.stringBytes.length <= 16) {
        scanner.stringBytes.push(byte);
      }
      return;
    }

    scanner.inString = false;
    if (scanner.stringRole === 'key') {
      scanner.currentKeyIsType = capturedStringEquals(scanner, 'type');
      scanner.phase = 'colon';
    } else if (scanner.stringRole === 'value') {
      if (scanner.currentKeyIsType && capturedStringEquals(scanner, 'compacted')) {
        scanner.compacted = true;
      }
      scanner.phase = 'comma';
    }
    scanner.stringRole = null;
    scanner.stringBytes = [];
    return;
  }

  if (isWhitespace(byte)) return;
  if (scanner.phase === 'root') {
    if (byte === 0x7b) {
      scanner.depth = 1;
      scanner.phase = 'key';
    } else {
      scanner.phase = 'done';
    }
    return;
  }
  if (scanner.phase === 'key') {
    if (byte === 0x22) {
      scanner.inString = true;
      scanner.stringRole = 'key';
      scanner.stringBytes = [];
    } else if (byte === 0x7d) {
      scanner.phase = 'done';
    }
    return;
  }
  if (scanner.phase === 'colon') {
    if (byte === 0x3a) scanner.phase = 'value';
    return;
  }
  if (scanner.phase === 'value') {
    if (byte === 0x22) {
      scanner.inString = true;
      scanner.stringRole = 'value';
      scanner.stringBytes = [];
    } else if (byte === 0x7b || byte === 0x5b) {
      scanner.depth = 2;
      scanner.phase = 'nested';
    } else {
      scanner.phase = 'primitive';
      scanTopLevelType(scanner, byte);
    }
    return;
  }
  if (scanner.phase === 'nested') {
    if (byte === 0x22) {
      scanner.inString = true;
      scanner.stringRole = null;
      return;
    }
    if (byte === 0x7b || byte === 0x5b) scanner.depth++;
    if (byte === 0x7d || byte === 0x5d) {
      scanner.depth--;
      if (scanner.depth === 1) scanner.phase = 'comma';
    }
    return;
  }
  if (scanner.phase === 'primitive') {
    if (byte === 0x2c) scanner.phase = 'key';
    if (byte === 0x7d) scanner.phase = 'done';
    return;
  }
  if (scanner.phase === 'comma') {
    if (byte === 0x2c) scanner.phase = 'key';
    if (byte === 0x7d) scanner.phase = 'done';
  }
}

function appendPartial(partial: PartialLine, bytes: Buffer): void {
  if (bytes.length === 0 || partial.skipCompacted) return;
  partial.chunks.push(Buffer.from(bytes));
  partial.length += bytes.length;
  for (const byte of bytes) {
    scanTopLevelType(partial.scanner, byte);
    if (partial.scanner.compacted) {
      partial.skipCompacted = true;
      partial.chunks = [];
      partial.length = 0;
      return;
    }
  }
}

function finishPartial(
  state: RolloutTailState,
  lineEnd: number,
  lines: CodexRolloutLine[],
  lineEnds: number[],
): void {
  const partial = state.partial;
  if (partial.skipCompacted) {
    lines.push({ type: 'compacted' });
    lineEnds.push(lineEnd);
  } else if (partial.length > 0) {
    try {
      const bytes = partial.chunks.length === 1
        ? partial.chunks[0]
        : Buffer.concat(partial.chunks, partial.length);
      lines.push(JSON.parse(bytes.toString('utf8')) as CodexRolloutLine);
      lineEnds.push(lineEnd);
    } catch {
      // Malformed complete lines still advance completeOffset.
    }
  }
  state.partial = createPartialLine();
  state.completeOffset = lineEnd;
}

/**
 * Read the lines appended to `file` since `offset`.
 *
 * Only whole lines are consumed: a trailing partial line (codex mid-write) stays
 * unread and the returned `offset` sits on the last newline, so the next call
 * picks it up. Cutting on '\n' can never split a UTF-8 sequence — 0x0A does not
 * appear inside a multi-byte encoding — so decoding the consumed span is safe
 * even though the file is being appended to concurrently.
 */
export function readRolloutDelta(
  file: string,
  offsetOrState: number | RolloutTailState,
): RolloutDelta {
  const state = typeof offsetOrState === 'number'
    ? createRolloutTailState(offsetOrState)
    : offsetOrState;
  const empty = (
    at: number,
    fileSizeBytes: number | null,
    rolloutIdentity: string | null,
    truncated = false,
  ): RolloutDelta => ({
    lines: [],
    lineEnds: [],
    offset: at,
    fileSizeBytes,
    rolloutIdentity,
    bytesRead: 0,
    pendingBytes: state.partial.length,
    truncated,
  });

  let fd: number;
  let fileSizeBytes: number | null = null;
  const lines: CodexRolloutLine[] = [];
  const lineEnds: number[] = [];
  let bytesRead = 0;
  try {
    fd = openSync(file, 'r');
  } catch {
    return empty(state.completeOffset, null, null);
  }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const rolloutIdentity = `${stat.dev}:${stat.ino}`;
    fileSizeBytes = size;
    if (state.rolloutIdentity !== null && state.rolloutIdentity !== rolloutIdentity) {
      state.readPosition = 0;
      state.completeOffset = 0;
      state.startOffset = 0;
      state.rolloutIdentity = rolloutIdentity;
      state.partial = createPartialLine();
      return empty(0, size, rolloutIdentity, true);
    }
    state.rolloutIdentity = rolloutIdentity;
    if (size < state.readPosition || size < state.completeOffset) {
      state.readPosition = 0;
      state.completeOffset = 0;
      state.startOffset = 0;
      state.partial = createPartialLine();
      return empty(0, size, rolloutIdentity, true);
    }
    if (size === state.readPosition) {
      return empty(state.completeOffset, size, rolloutIdentity);
    }

    const chunk = Buffer.allocUnsafe(CHUNK);
    while (state.readPosition < size) {
      const requested = Math.min(CHUNK, size - state.readPosition);
      const n = state.readChunk(fd, chunk, 0, requested, state.readPosition);
      if (n <= 0) break;
      const chunkStart = state.readPosition;
      state.readPosition += n;
      bytesRead += n;
      let segmentStart = 0;
      while (segmentStart < n) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        if (newline < 0 || newline >= n) {
          appendPartial(state.partial, chunk.subarray(segmentStart, n));
          break;
        }
        appendPartial(state.partial, chunk.subarray(segmentStart, newline));
        finishPartial(state, chunkStart + newline + 1, lines, lineEnds);
        segmentStart = newline + 1;
      }
    }
    return {
      lines,
      lineEnds,
      offset: state.completeOffset,
      fileSizeBytes: size,
      rolloutIdentity,
      bytesRead,
      pendingBytes: state.partial.length,
      truncated: false,
    };
  } catch {
    return {
      lines,
      lineEnds,
      offset: state.completeOffset,
      fileSizeBytes,
      rolloutIdentity: state.rolloutIdentity,
      bytesRead,
      pendingBytes: state.partial.length,
      truncated: false,
    };
  } finally {
    closeSync(fd);
  }
}

export interface RolloutPrefix {
  /** Byte offset just past line `lineIndex`. */
  offset: number;
  /** `task_complete` lines within the prefix. */
  turns: number;
  /** Lines actually found (< `lineIndex` if the rollout is shorter). */
  lines: number;
  /** Physical generation inspected by this scan. */
  rolloutIdentity: string;
  /** Codex session id found in the scanned prefix, when present. */
  sessionId: string | null;
}

const CHUNK = 1 << 20;

/**
 * Byte offset and completed-turn count for the first `lineIndex` parsed lines,
 * read in chunks so a huge rollout never becomes one huge string.
 *
 * Only used to migrate a legacy integer cursor, which carried a line index but
 * no byte offset. Once migrated the persisted cursor holds the offset itself and
 * nothing reads the rollout from the start again.
 */
export function scanRolloutPrefix(file: string, lineIndex: number): RolloutPrefix | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const rolloutIdentity = `${stat.dev}:${stat.ino}`;
    const chunk = Buffer.allocUnsafe(CHUNK);
    const tail = createRolloutTailState();
    let position = 0;
    let offset = 0;
    let lines = 0;
    let turns = 0;
    let sessionId: string | null = null;

    while (position < size && lines < lineIndex) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, size - position), position);
      if (n <= 0) return null;
      let segmentStart = 0;
      while (segmentStart < n && lines < lineIndex) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        if (newline < 0 || newline >= n) {
          appendPartial(tail.partial, chunk.subarray(segmentStart, n));
          break;
        }
        appendPartial(tail.partial, chunk.subarray(segmentStart, newline));
        const parsed: CodexRolloutLine[] = [];
        const ends: number[] = [];
        finishPartial(tail, position + newline + 1, parsed, ends);
        if (parsed.length === 1) {
          lines++;
          sessionId ??= rolloutSessionId(parsed);
          if (isTaskComplete(parsed[0])) turns++;
          offset = ends[0];
        }
        segmentStart = newline + 1;
      }
      position += n;
    }
    return {
      offset: Math.min(offset, size),
      turns,
      lines,
      rolloutIdentity,
      sessionId,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A rollout line that closes a turn. */
export function isTaskComplete(line: CodexRolloutLine): boolean {
  return (
    line.type === 'event_msg' &&
    (line.payload as { type?: string } | undefined)?.type === 'task_complete'
  );
}
