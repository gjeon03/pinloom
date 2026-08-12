import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  readSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRolloutTailState,
  readRolloutDelta,
  scanRolloutPrefix,
  isTaskComplete,
} from './rollout-tail.js';
import { parseRolloutText, countTaskComplete } from '../codex-rollout/parse.js';

/** What readRolloutLines() did — the oracle these tests hold the reader to. */
function wholeFile(file: string) {
  return parseRolloutText(readFileSync(file, 'utf8'));
}

const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } });
const user = (m: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: m } });
const done = (m: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: m } });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rollout-tail-'));
  file = path.join(dir, 'rollout.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRolloutDelta', () => {
  it('reads each appended byte once while retaining a normal partial line by chunks', () => {
    const tail = createRolloutTailState();
    const pieces = [
      '{"type":"event_msg","payload":{"type":"agent_message","message":"',
      '한글과 emoji 🎉',
      '"}}',
    ];
    writeFileSync(file, pieces[0]);

    const first = readRolloutDelta(file, tail);
    expect(first.lines).toEqual([]);
    expect(first.bytesRead).toBe(Buffer.byteLength(pieces[0]));
    expect(first.pendingBytes).toBe(Buffer.byteLength(pieces[0]));

    appendFileSync(file, pieces[1]);
    const second = readRolloutDelta(file, tail);
    expect(second.lines).toEqual([]);
    expect(second.bytesRead).toBe(Buffer.byteLength(pieces[1]));
    expect(second.pendingBytes).toBe(Buffer.byteLength(pieces[0] + pieces[1]));

    appendFileSync(file, `${pieces[2]}\n`);
    const third = readRolloutDelta(file, tail);
    expect(third.bytesRead).toBe(Buffer.byteLength(`${pieces[2]}\n`));
    expect(third.pendingBytes).toBe(0);
    expect(third.lines).toEqual(wholeFile(file));
  });

  it('streams a partial compacted payload into one small sentinel without retaining or rereading it', () => {
    const tail = createRolloutTailState();
    const prefix = '{"type":"compacted","payload":{"replacement_history":["';
    const payload = 'x'.repeat((1 << 20) * 2 + 137);
    const suffix = '"]}}\n';
    writeFileSync(file, prefix);

    const first = readRolloutDelta(file, tail);
    expect(first.lines).toEqual([]);
    expect(first.bytesRead).toBe(Buffer.byteLength(prefix));
    expect(first.pendingBytes).toBe(0);

    appendFileSync(file, payload);
    const second = readRolloutDelta(file, tail);
    expect(second.lines).toEqual([]);
    expect(second.bytesRead).toBe(Buffer.byteLength(payload));
    expect(second.pendingBytes).toBe(0);

    appendFileSync(file, suffix);
    const third = readRolloutDelta(file, tail);
    expect(third.bytesRead).toBe(Buffer.byteLength(suffix));
    expect(third.pendingBytes).toBe(0);
    expect(third.lines).toEqual([{ type: 'compacted' }]);
    expect(third.lineEnds).toEqual([Buffer.byteLength(prefix + payload + suffix)]);
    expect(third.offset).toBe(Buffer.byteLength(prefix + payload + suffix));
  });

  it('does not classify nested or string content as a top-level compacted record', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'nested text says "type":"compacted"',
        nested: { type: 'compacted' },
      },
    });
    writeFileSync(file, `${line}\n`);

    const delta = readRolloutDelta(file, createRolloutTailState());

    expect(delta.lines).toEqual([JSON.parse(line)]);
  });

  it('detects an inode replacement even when the replacement is not shorter', () => {
    const tail = createRolloutTailState();
    writeFileSync(file, `${user('old')}\n`);
    const first = readRolloutDelta(file, tail);
    const oldIdentity = first.rolloutIdentity;
    renameSync(file, `${file}.old`);
    writeFileSync(file, `${user('replacement is deliberately longer')}\n`);

    const replaced = readRolloutDelta(file, tail);

    expect(replaced.truncated).toBe(true);
    expect(replaced.rolloutIdentity).not.toBe(oldIdentity);
    expect(replaced.offset).toBe(0);
  });

  it('returns completed lines and resumes after a mid-read error', () => {
    const firstLine = user('before read error');
    const compacted = `{"type":"compacted","payload":{"replacement_history":["${'q'.repeat(
      (1 << 20) * 2,
    )}"]}}`;
    writeFileSync(file, `${firstLine}\n${compacted}\n`);
    let reads = 0;
    const tail = createRolloutTailState(0, {
      readChunk: (...args) => {
        reads++;
        if (reads === 2) throw new Error('injected read error');
        return readSync(...args);
      },
    });

    const interrupted = readRolloutDelta(file, tail);
    const resumed = readRolloutDelta(file, tail);

    expect(interrupted.lines).toEqual([JSON.parse(firstLine)]);
    expect(interrupted.bytesRead).toBe(1 << 20);
    expect(resumed.lines).toEqual([{ type: 'compacted' }]);
    expect(resumed.bytesRead).toBe(Buffer.byteLength(`${firstLine}\n${compacted}\n`) - (1 << 20));
    expect(resumed.offset).toBe(Buffer.byteLength(`${firstLine}\n${compacted}\n`));
  });

  it('returns nothing for a missing file', () => {
    const d = readRolloutDelta(path.join(dir, 'nope.jsonl'), 0);
    expect(d.lines).toEqual([]);
    expect(d.offset).toBe(0);
    expect(d.fileSizeBytes).toBeNull();
    expect(d.truncated).toBe(false);
  });

  it('reports the empty file size at EOF', () => {
    writeFileSync(file, '');
    const d = readRolloutDelta(file, 0);

    expect(d.fileSizeBytes).toBe(0);
    expect(d.offset).toBe(0);
  });

  it('reads a whole file from offset 0 identically to the whole-file parser', () => {
    writeFileSync(file, [meta('s1'), user('hi'), done('bye')].join('\n') + '\n');
    const d = readRolloutDelta(file, 0);
    expect(d.lines).toEqual(wholeFile(file));
    expect(d.offset).toBe(readFileSync(file).length);
  });

  it('reads only what was appended since the last offset', () => {
    writeFileSync(file, [meta('s1'), user('one')].join('\n') + '\n');
    const first = readRolloutDelta(file, 0);
    expect(first.lines).toHaveLength(2);

    appendFileSync(file, done('reply') + '\n');
    const second = readRolloutDelta(file, first.offset);
    expect(second.lines).toHaveLength(1);
    expect(isTaskComplete(second.lines[0])).toBe(true);
    expect([...first.lines, ...second.lines]).toEqual(wholeFile(file));
  });

  it('holds back a partial trailing line until its newline lands', () => {
    writeFileSync(file, user('complete') + '\n');
    const first = readRolloutDelta(file, 0);
    expect(first.lines).toHaveLength(1);

    // codex mid-write: no trailing newline yet.
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_comp');
    const partial = readRolloutDelta(file, first.offset);
    expect(partial.lines).toEqual([]);
    expect(partial.offset).toBe(first.offset);

    appendFileSync(file, 'lete","last_agent_message":"ok"}}\n');
    const rest = readRolloutDelta(file, partial.offset);
    expect(rest.lines).toHaveLength(1);
    expect([...first.lines, ...rest.lines]).toEqual(wholeFile(file));
  });

  it('reports the physical file size while retaining an incomplete trailing line', () => {
    const complete = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`;
    const partial = '{"type":"event_msg"';
    writeFileSync(file, complete + partial);

    const delta = readRolloutDelta(file, 0);

    expect(delta.lines).toHaveLength(1);
    expect(delta.offset).toBe(Buffer.byteLength(complete));
    expect(delta.fileSizeBytes).toBe(Buffer.byteLength(complete + partial));
  });

  it('keeps lineEnds aligned with lines when blank and malformed lines are dropped', () => {
    writeFileSync(file, [meta('s1'), '', 'not json at all', user('after')].join('\n') + '\n');
    const d = readRolloutDelta(file, 0);
    expect(d.lines).toEqual(wholeFile(file));
    expect(d.lineEnds).toHaveLength(d.lines.length);
    // Resuming from the first line's end must yield exactly the remainder.
    const rest = readRolloutDelta(file, d.lineEnds[0]);
    expect(rest.lines).toEqual(d.lines.slice(1));
  });

  it('survives multi-byte characters split across reads', () => {
    const rows = Array.from({ length: 200 }, (_, i) => user(`한글 메시지 ${i} — 이모지 🎉`));
    writeFileSync(file, rows.join('\n') + '\n');
    let offset = 0;
    const seen = [];
    // Feed it in as many steps as there are lines, resuming each time.
    for (let i = 0; i < rows.length; i++) {
      const d = readRolloutDelta(file, offset);
      if (d.lines.length === 0) break;
      seen.push(...d.lines);
      offset = d.offset;
      if (offset >= readFileSync(file).length) break;
    }
    expect(seen).toEqual(wholeFile(file));
  });

  it('flags truncation when the file shrinks below the offset', () => {
    writeFileSync(file, [user('a'), user('b')].join('\n') + '\n');
    const full = readRolloutDelta(file, 0);
    writeFileSync(file, user('fresh') + '\n');
    const d = readRolloutDelta(file, full.offset);
    expect(d.truncated).toBe(true);
    expect(d.offset).toBe(0);
    expect(d.fileSizeBytes).toBe(Buffer.byteLength(user('fresh') + '\n'));
  });

  it('matches the whole-file parser across a randomized append stream', () => {
    writeFileSync(file, '');
    let offset = 0;
    const seen = [];
    for (let turn = 0; turn < 40; turn++) {
      const batch = [user(`q${turn}`), user('x'.repeat(turn * 7)), done(`a${turn}`)];
      appendFileSync(file, batch.join('\n') + '\n');
      const d = readRolloutDelta(file, offset);
      seen.push(...d.lines);
      offset = d.offset;
    }
    expect(seen).toEqual(wholeFile(file));
    expect(seen.filter(isTaskComplete)).toHaveLength(countTaskComplete(wholeFile(file)));
  });
});

describe('scanRolloutPrefix', () => {
  it('distinguishes an unavailable file from a zero-line prefix', () => {
    expect(scanRolloutPrefix(path.join(dir, 'nope.jsonl'), 2)).toBeNull();
    expect(scanRolloutPrefix(file, 0)).toBeNull();
  });

  it('gets physical identity without reading lines for a zero line index', () => {
    writeFileSync(file, user('a') + '\n');
    expect(scanRolloutPrefix(file, 0)).toEqual({
      offset: 0,
      turns: 0,
      lines: 0,
      rolloutIdentity: expect.any(String),
      sessionId: null,
    });
  });

  it('reports the offset and turn count of the first N lines', () => {
    const rows = [meta('s1'), user('q1'), done('a1'), user('q2'), done('a2')];
    writeFileSync(file, rows.join('\n') + '\n');
    const all = wholeFile(file);

    for (let n = 1; n <= all.length; n++) {
      const prefix = scanRolloutPrefix(file, n);
      expect(prefix.lines).toBe(n);
      expect(prefix.turns).toBe(countTaskComplete(all.slice(0, n)));
      // Resuming at the reported offset must yield exactly the remaining lines.
      const rest = readRolloutDelta(file, prefix.offset);
      expect(rest.lines).toEqual(all.slice(n));
    }
  });

  it('agrees with the oracle on a file larger than one read chunk', () => {
    // >1MB so the chunked path runs, with lines that straddle chunk boundaries.
    const rows = [];
    for (let i = 0; i < 400; i++) {
      rows.push(user(`한글 ${i} ${'y'.repeat(3000)}`));
      if (i % 5 === 4) rows.push(done(`reply ${i}`));
    }
    writeFileSync(file, rows.join('\n') + '\n');
    const all = wholeFile(file);
    expect(readFileSync(file).length).toBeGreaterThan(1 << 20);

    for (const n of [1, 7, 123, 300, all.length - 1, all.length]) {
      const prefix = scanRolloutPrefix(file, n);
      expect({ n, ...prefix }).toEqual({
        n,
        lines: n,
        turns: countTaskComplete(all.slice(0, n)),
        offset: prefix.offset,
        rolloutIdentity: expect.any(String),
        sessionId: null,
      });
      expect(readRolloutDelta(file, prefix.offset).lines).toEqual(all.slice(n));
    }
  });

  it('counts a huge compacted prefix without parsing its replacement history', () => {
    const compacted = `{"type":"compacted","payload":{"replacement_history":["${'z'.repeat(
      (1 << 20) * 2 + 29,
    )}"]}}`;
    const trailing = user('after compacted');
    writeFileSync(file, `${compacted}\n${trailing}\n`);

    const prefix = scanRolloutPrefix(file, 1);

    expect(prefix).toEqual({
      lines: 1,
      turns: 0,
      offset: Buffer.byteLength(`${compacted}\n`),
      rolloutIdentity: expect.any(String),
      sessionId: null,
    });
    expect(readRolloutDelta(file, prefix?.offset ?? 0).lines).toEqual([JSON.parse(trailing)]);
  });

  it('stops at the end when asked for more lines than exist', () => {
    const rows = [user('a'), done('b')];
    writeFileSync(file, rows.join('\n') + '\n');
    const prefix = scanRolloutPrefix(file, 99);
    expect(prefix.lines).toBe(2);
    expect(prefix.offset).toBe(readFileSync(file).length);
    expect(readRolloutDelta(file, prefix.offset).lines).toEqual([]);
  });
});
