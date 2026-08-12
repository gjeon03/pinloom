import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createClaudeTranscriptTailState,
  readClaudeTranscriptDelta,
} from './transcript-tail.js';

const line = (type: 'user' | 'assistant', uuid: string, text: string) =>
  JSON.stringify({ type, uuid, message: { content: text } });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'claude-transcript-tail-'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readClaudeTranscriptDelta', () => {
  it('reads one-line appends and performs no reads for an unchanged file', () => {
    const reads: Array<{ length: number; position: number | null }> = [];
    const tail = createClaudeTranscriptTailState(0, {
      readChunk: (fd, buffer, offset, length, position) => {
        reads.push({ length, position });
        return readSync(fd, buffer, offset, length, position);
      },
    });
    const firstLine = `${line('user', 'u1', 'hello')}\n`;
    writeFileSync(file, firstLine);

    const first = readClaudeTranscriptDelta(file, tail);
    expect(first.lines.map((entry) => entry.uuid)).toEqual(['u1']);
    expect(first.completeOffset).toBe(Buffer.byteLength(firstLine));
    expect(first.bytesRead).toBe(Buffer.byteLength(firstLine));
    expect(reads).toEqual([{ length: Buffer.byteLength(firstLine), position: 0 }]);

    const idle = readClaudeTranscriptDelta(file, tail);
    expect(idle.lines).toEqual([]);
    expect(idle.bytesRead).toBe(0);
    expect(reads).toHaveLength(1);

    const secondLine = `${line('assistant', 'a1', 'reply')}\n`;
    appendFileSync(file, secondLine);
    const second = readClaudeTranscriptDelta(file, tail);
    expect(second.lines.map((entry) => entry.uuid)).toEqual(['a1']);
    expect(second.lineEnds).toEqual([Buffer.byteLength(firstLine + secondLine)]);
    expect(second.bytesRead).toBe(Buffer.byteLength(secondLine));
    expect(reads).toEqual([
      { length: Buffer.byteLength(firstLine), position: 0 },
      { length: Buffer.byteLength(secondLine), position: Buffer.byteLength(firstLine) },
    ]);
  });

  it('reuses one state for multiple appends', () => {
    const tail = createClaudeTranscriptTailState();
    const seen: string[] = [];
    for (const [type, uuid] of [
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
    ] as const) {
      appendFileSync(file, `${line(type, uuid, uuid)}\n`);
      seen.push(...readClaudeTranscriptDelta(file, tail).lines.map((entry) => entry.uuid ?? ''));
    }
    expect(seen).toEqual(['u1', 'a1', 'u2']);
  });

  it('decodes UTF-8 only after a line is complete across injected reads', () => {
    const raw = `${line('assistant', 'a1', '한글 🎉')}\n`;
    writeFileSync(file, raw);
    const tail = createClaudeTranscriptTailState(0, {
      readChunk: (fd, buffer, offset, length, position) =>
        readSync(fd, buffer, offset, Math.min(length, 2), position),
    });

    const delta = readClaudeTranscriptDelta(file, tail);
    expect(delta.lines).toHaveLength(1);
    expect(delta.lines[0]?.message?.content).toBe('한글 🎉');
    expect(delta.completeOffset).toBe(Buffer.byteLength(raw));
  });

  it('retains a partial final JSON record until it completes, exactly once', () => {
    const tail = createClaudeTranscriptTailState();
    const complete = `${line('user', 'u1', 'first')}\n`;
    const partial = line('assistant', 'a1', 'second');
    writeFileSync(file, complete + partial.slice(0, -4));

    const first = readClaudeTranscriptDelta(file, tail);
    expect(first.lines.map((entry) => entry.uuid)).toEqual(['u1']);
    expect(first.completeOffset).toBe(Buffer.byteLength(complete));
    expect(first.pendingBytes).toBeGreaterThan(0);

    appendFileSync(file, `${partial.slice(-4)}\n`);
    const second = readClaudeTranscriptDelta(file, tail);
    expect(second.lines.map((entry) => entry.uuid)).toEqual(['a1']);
    expect(second.completeOffset).toBe(Buffer.byteLength(`${complete}${partial}\n`));
    expect(readClaudeTranscriptDelta(file, tail).lines).toEqual([]);
  });

  it('consumes malformed complete JSON without returning it', () => {
    const valid = `${line('user', 'u1', 'ok')}\n`;
    const malformed = '{broken json}\n';
    writeFileSync(file, valid + malformed);

    const delta = readClaudeTranscriptDelta(file, createClaudeTranscriptTailState());
    expect(delta.lines.map((entry) => entry.uuid)).toEqual(['u1']);
    expect(delta.lineEnds).toEqual([Buffer.byteLength(valid)]);
    expect(delta.completeOffset).toBe(Buffer.byteLength(valid + malformed));
    expect(delta.pendingBytes).toBe(0);
  });

  it('rolls back the entire attempted range after an interrupted read', () => {
    const first = `${line('user', 'u1', 'before interruption')}\n`;
    const second = `${line('assistant', 'a1', 'x'.repeat((1 << 20) * 2))}\n`;
    writeFileSync(file, first + second);
    let reads = 0;
    const positions: Array<number | null> = [];
    const tail = createClaudeTranscriptTailState(0, {
      readChunk: (...args) => {
        reads++;
        positions.push(args[4]);
        if (reads === 2) throw new Error('injected read failure');
        return readSync(...args);
      },
    });

    const interrupted = readClaudeTranscriptDelta(file, tail);
    expect(interrupted).toMatchObject({
      lines: [],
      lineEnds: [],
      completeOffset: 0,
      bytesRead: 0,
      pendingBytes: 0,
    });
    expect(tail.readPosition).toBe(0);
    expect(tail.completeOffset).toBe(0);

    const resumed = readClaudeTranscriptDelta(file, tail);
    expect(resumed.lines.map((entry) => entry.uuid)).toEqual(['u1', 'a1']);
    expect(resumed.completeOffset).toBe(Buffer.byteLength(first + second));
    expect(positions[2]).toBe(0);
  });

  it('resets before reading a replacement inode', () => {
    const tail = createClaudeTranscriptTailState();
    writeFileSync(file, `${line('user', 'old', 'old')}\n`);
    const first = readClaudeTranscriptDelta(file, tail);
    renameSync(file, `${file}.old`);
    writeFileSync(file, `${line('assistant', 'new', 'replacement')}\n`);

    const reset = readClaudeTranscriptDelta(file, tail);
    expect(reset.reset).toBe(true);
    expect(reset.completeOffset).toBe(0);
    expect(reset.transcriptIdentity).not.toBe(first.transcriptIdentity);
    expect(readClaudeTranscriptDelta(file, tail).lines.map((entry) => entry.uuid)).toEqual(['new']);
  });

  it('resets before reading a same-inode truncation', () => {
    const tail = createClaudeTranscriptTailState();
    writeFileSync(file, `${line('user', 'old', 'x'.repeat(200))}\n`);
    readClaudeTranscriptDelta(file, tail);
    writeFileSync(file, `${line('assistant', 'new', 'new')}\n`);

    const reset = readClaudeTranscriptDelta(file, tail);
    expect(reset.reset).toBe(true);
    expect(reset.completeOffset).toBe(0);
    expect(readClaudeTranscriptDelta(file, tail).lines.map((entry) => entry.uuid)).toEqual(['new']);
  });

  it('reads only appended bytes after an initial file larger than one MiB', () => {
    const reads: Array<{ length: number; position: number | null }> = [];
    const tail = createClaudeTranscriptTailState(0, {
      readChunk: (fd, buffer, offset, length, position) => {
        reads.push({ length, position });
        return readSync(fd, buffer, offset, length, position);
      },
    });
    const large = `${line('assistant', 'a1', 'x'.repeat((1 << 20) + 100))}\n`;
    writeFileSync(file, large);
    const first = readClaudeTranscriptDelta(file, tail);
    expect(first.bytesRead).toBe(Buffer.byteLength(large));
    expect(reads).toEqual([
      { length: 1 << 20, position: 0 },
      { length: Buffer.byteLength(large) - (1 << 20), position: 1 << 20 },
    ]);

    const appended = `${line('user', 'u2', 'small append')}\n`;
    appendFileSync(file, appended);
    const second = readClaudeTranscriptDelta(file, tail);
    expect(second.lines.map((entry) => entry.uuid)).toEqual(['u2']);
    expect(second.bytesRead).toBe(Buffer.byteLength(appended));
    expect(reads).toEqual([
      { length: 1 << 20, position: 0 },
      { length: Buffer.byteLength(large) - (1 << 20), position: 1 << 20 },
      { length: Buffer.byteLength(appended), position: Buffer.byteLength(large) },
    ]);
  });
});
