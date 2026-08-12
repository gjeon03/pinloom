import {
  appendFileSync,
  mkdtempSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toNormalizedEvents, type JsonlLine } from '../claude-jsonl/index.js';
import { createClaudeTurnTranscriptReader } from './node-session.js';
import { readCheckpoint } from './transcript.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempTranscript(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pinloom-claude-sdk-tail-'));
  tempDirs.push(dir);
  return path.join(dir, 'session.jsonl');
}

function jsonl(line: JsonlLine): string {
  return `${JSON.stringify(line)}\n`;
}

function userLine(uuid: string, parentUuid: string | null, text: string): JsonlLine {
  return {
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: text },
  };
}

function assistantLine(uuid: string, parentUuid: string, text: string): JsonlLine {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
    },
  };
}

describe('createClaudeTurnTranscriptReader', () => {
  it('reads only bytes appended after a large resume checkpoint across later turns', async () => {
    const file = tempTranscript();
    const padding = 'x'.repeat((1 << 20) + 128);
    writeFileSync(
      file,
      jsonl({ type: 'system', uuid: 'history', message: { content: padding } }),
    );
    const checkpoint = readCheckpoint(file);
    expect(checkpoint).not.toBeNull();

    const reads: Array<{ position: number; bytes: number }> = [];
    const readChunk: typeof readSync = (fd, buffer, offset, length, position) => {
      const bytes = readSync(fd, buffer, offset, length, position);
      reads.push({ position: typeof position === 'number' ? position : -1, bytes });
      return bytes;
    };
    const reader = createClaudeTurnTranscriptReader(checkpoint, {
      readChunk,
      wait: async () => undefined,
    });

    const firstAppend = jsonl(userLine('u1', 'history', 'first')) +
      jsonl(assistantLine('a1', 'u1', 'echo: first'));
    appendFileSync(file, firstAppend);
    const first = await reader.readTurnSettled(file);

    const secondAppend = jsonl(userLine('u2', 'a1', 'second')) +
      jsonl(assistantLine('a2', 'u2', 'echo: second'));
    appendFileSync(file, secondAppend);
    const second = await reader.readTurnSettled(file);

    expect(first.map((line) => line.uuid)).toEqual(['u1', 'a1']);
    expect(second.map((line) => line.uuid)).toEqual(['u2', 'a2']);
    expect(toNormalizedEvents(first)).toContainEqual({
      type: 'text_delta',
      text: 'echo: first',
    });
    expect(toNormalizedEvents(second)).toContainEqual({
      type: 'text_delta',
      text: 'echo: second',
    });
    expect(reads[0]?.position).toBe(checkpoint?.completeOffset);
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(
      Buffer.byteLength(firstAppend + secondAppend),
    );
  });

  it('retains a partial assistant line until a later flush completes it', async () => {
    const file = tempTranscript();
    const user = jsonl(userLine('u1', null, 'hello'));
    const assistant = JSON.stringify(assistantLine('a1', 'u1', 'echo: hello'));
    writeFileSync(file, user + assistant);

    const wait = vi.fn(async () => {
      appendFileSync(file, '\n');
    });
    const positions: number[] = [];
    const readChunk: typeof readSync = (fd, buffer, offset, length, position) => {
      positions.push(typeof position === 'number' ? position : -1);
      return readSync(fd, buffer, offset, length, position);
    };
    const reader = createClaudeTurnTranscriptReader(null, {
      readChunk,
      wait,
      settleAttempts: 3,
    });

    const turn = await reader.readTurnSettled(file);

    expect(turn.map((line) => line.uuid)).toEqual(['u1', 'a1']);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(positions).toEqual([0, Buffer.byteLength(user + assistant)]);
  });

  it('discards a reply that arrives after the previous settle window before the next turn', async () => {
    const file = tempTranscript();
    writeFileSync(file, jsonl(userLine('u1', null, 'first')));
    const reader = createClaudeTurnTranscriptReader(null, {
      wait: async () => undefined,
      settleAttempts: 1,
    });

    expect((await reader.readTurnSettled(file)).map((line) => line.uuid)).toEqual(['u1']);
    appendFileSync(file, jsonl(assistantLine('a1', 'u1', 'late first reply')));
    reader.discardPending(file);
    appendFileSync(
      file,
      jsonl(userLine('u2', 'a1', 'second')) +
        jsonl(assistantLine('a2', 'u2', 'second reply')),
    );

    expect((await reader.readTurnSettled(file)).map((line) => line.uuid)).toEqual([
      'u2',
      'a2',
    ]);
  });
});
