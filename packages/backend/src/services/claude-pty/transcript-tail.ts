import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { parseJsonlLine, type JsonlLine } from '../claude-jsonl/index.js';

const CHUNK_SIZE = 1 << 20;

interface PartialLine {
  chunks: Buffer[];
  length: number;
}

interface TailStateSnapshot {
  readPosition: number;
  completeOffset: number;
  transcriptIdentity: string | null;
  partial: PartialLine;
}

export interface ClaudeTranscriptTailState {
  /** Physical position already read, including an unfinished final record. */
  readPosition: number;
  /** Physical position immediately after the last completed newline. */
  completeOffset: number;
  /** Identity of the transcript generation currently being tailed. */
  transcriptIdentity: string | null;
  partial: PartialLine;
  readChunk: typeof readSync;
}

export interface ClaudeTranscriptDelta {
  lines: JsonlLine[];
  /** Absolute byte end positions corresponding 1:1 to `lines`. */
  lineEnds: number[];
  completeOffset: number;
  fileSizeBytes: number | null;
  transcriptIdentity: string | null;
  bytesRead: number;
  pendingBytes: number;
  /** The underlying transcript was replaced or truncated before this poll. */
  reset: boolean;
}

function createPartialLine(): PartialLine {
  return { chunks: [], length: 0 };
}

export function createClaudeTranscriptTailState(
  offset = 0,
  dependencies: {
    readChunk?: typeof readSync;
    transcriptIdentity?: string | null;
  } = {},
): ClaudeTranscriptTailState {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  return {
    readPosition: safeOffset,
    completeOffset: safeOffset,
    transcriptIdentity: dependencies.transcriptIdentity ?? null,
    partial: createPartialLine(),
    readChunk: dependencies.readChunk ?? readSync,
  };
}

function appendPartial(partial: PartialLine, bytes: Buffer): void {
  if (bytes.length === 0) return;
  partial.chunks.push(Buffer.from(bytes));
  partial.length += bytes.length;
}

function consumePartial(
  state: ClaudeTranscriptTailState,
  lineEnd: number,
  lines: JsonlLine[],
  lineEnds: number[],
): void {
  const partial = state.partial;
  if (partial.length > 0) {
    const bytes = partial.chunks.length === 1
      ? partial.chunks[0]
      : Buffer.concat(partial.chunks, partial.length);
    const parsed = parseJsonlLine(bytes.toString('utf8'));
    if (parsed) {
      lines.push(parsed);
      lineEnds.push(lineEnd);
    }
  }
  state.partial = createPartialLine();
  state.completeOffset = lineEnd;
}

function resetState(state: ClaudeTranscriptTailState, transcriptIdentity: string): void {
  state.readPosition = 0;
  state.completeOffset = 0;
  state.transcriptIdentity = transcriptIdentity;
  state.partial = createPartialLine();
}

function snapshotState(state: ClaudeTranscriptTailState): TailStateSnapshot {
  return {
    readPosition: state.readPosition,
    completeOffset: state.completeOffset,
    transcriptIdentity: state.transcriptIdentity,
    partial: {
      chunks: [...state.partial.chunks],
      length: state.partial.length,
    },
  };
}

function restoreState(state: ClaudeTranscriptTailState, snapshot: TailStateSnapshot): void {
  state.readPosition = snapshot.readPosition;
  state.completeOffset = snapshot.completeOffset;
  state.transcriptIdentity = snapshot.transcriptIdentity;
  state.partial = snapshot.partial;
}

function emptyDelta(
  state: ClaudeTranscriptTailState,
  fileSizeBytes: number | null,
  transcriptIdentity: string | null,
  reset = false,
): ClaudeTranscriptDelta {
  return {
    lines: [],
    lineEnds: [],
    completeOffset: state.completeOffset,
    fileSizeBytes,
    transcriptIdentity,
    bytesRead: 0,
    pendingBytes: state.partial.length,
    reset,
  };
}

/**
 * Read only records appended since the state's last physical read position.
 * A final record without a newline remains in memory until a later poll
 * completes it, so durable offsets always name complete JSONL boundaries.
 */
export function readClaudeTranscriptDelta(
  file: string,
  state: ClaudeTranscriptTailState,
): ClaudeTranscriptDelta {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return emptyDelta(state, null, null);
  }

  const initialState = snapshotState(state);
  const lines: JsonlLine[] = [];
  const lineEnds: number[] = [];
  let bytesRead = 0;
  let fileSizeBytes: number | null = null;
  try {
    const stat = fstatSync(fd);
    const transcriptIdentity = `${stat.dev}:${stat.ino}`;
    const size = stat.size;
    fileSizeBytes = size;

    if (
      (state.transcriptIdentity !== null && state.transcriptIdentity !== transcriptIdentity) ||
      size < state.readPosition ||
      size < state.completeOffset
    ) {
      resetState(state, transcriptIdentity);
      return emptyDelta(state, size, transcriptIdentity, true);
    }
    state.transcriptIdentity = transcriptIdentity;
    if (size === state.readPosition) {
      return emptyDelta(state, size, transcriptIdentity);
    }

    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    while (state.readPosition < size) {
      const requested = Math.min(CHUNK_SIZE, size - state.readPosition);
      const count = state.readChunk(fd, chunk, 0, requested, state.readPosition);
      if (count <= 0) throw new Error('transcript read ended before the observed file size');

      const chunkStart = state.readPosition;
      state.readPosition += count;
      bytesRead += count;
      let segmentStart = 0;
      while (segmentStart < count) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        if (newline < 0 || newline >= count) {
          appendPartial(state.partial, chunk.subarray(segmentStart, count));
          break;
        }
        appendPartial(state.partial, chunk.subarray(segmentStart, newline));
        consumePartial(state, chunkStart + newline + 1, lines, lineEnds);
        segmentStart = newline + 1;
      }
    }

    return {
      lines,
      lineEnds,
      completeOffset: state.completeOffset,
      fileSizeBytes: size,
      transcriptIdentity,
      bytesRead,
      pendingBytes: state.partial.length,
      reset: false,
    };
  } catch {
    restoreState(state, initialState);
    return emptyDelta(state, fileSizeBytes, state.transcriptIdentity);
  } finally {
    closeSync(fd);
  }
}
