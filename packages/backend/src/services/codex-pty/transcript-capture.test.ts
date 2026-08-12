import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { getCodexContextState } from '../codex-context.js';
import {
  commitCodexContextSummary,
  type CodexContextPendingSummary,
} from '../codex-context.js';
import {
  awaitCodexTurn,
  pollCodexCaptureOnce,
  startCodexCapture,
  stopCodexCapture,
} from './transcript-capture.js';

const { readRolloutDeltaSpy, scanRolloutPrefixSpy } = vi.hoisted(() => ({
  readRolloutDeltaSpy: vi.fn(),
  scanRolloutPrefixSpy: vi.fn(),
}));

const { commitCodexContextSummarySpy } = vi.hoisted(() => ({
  commitCodexContextSummarySpy: vi.fn(),
}));

vi.mock('./rollout-tail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rollout-tail.js')>();
  return {
    ...actual,
    readRolloutDelta: readRolloutDeltaSpy,
    scanRolloutPrefix: scanRolloutPrefixSpy,
  };
});

vi.mock('../codex-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-context.js')>();
  return {
    ...actual,
    commitCodexContextSummary: commitCodexContextSummarySpy,
  };
});

let sequence = 0;
let codexHome: string;
let sessionId: string;

function insertSession(id: string): void {
  const now = new Date().toISOString();
  const projectId = `codex-capture-project-${sequence++}`;
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)').run(
    projectId,
    'capture',
    `/tmp/${projectId}`,
    now,
    now,
  );
  db.prepare(
    'INSERT INTO sessions (id, project_id, agent, transport, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, projectId, 'codex', 'terminal', now, now);
}

function writeRollout(lines: string[]): string {
  const directory = path.join(codexHome, 'sessions', '2026', '08', '11');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-test.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function tokenLine(inputTokens: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 200 },
        model_context_window: 258400,
      },
    },
  });
}

beforeEach(async () => {
  codexHome = mkdtempSync(path.join(tmpdir(), 'codex-capture-'));
  sessionId = `codex-capture-${sequence++}`;
  insertSession(sessionId);
  const actual = await vi.importActual<typeof import('./rollout-tail.js')>('./rollout-tail.js');
  readRolloutDeltaSpy.mockImplementation(actual.readRolloutDelta);
  scanRolloutPrefixSpy.mockImplementation(actual.scanRolloutPrefix);
  const context = await vi.importActual<typeof import('../codex-context.js')>('../codex-context.js');
  commitCodexContextSummarySpy.mockImplementation(context.commitCodexContextSummary);
});

afterEach(() => {
  stopCodexCapture(sessionId);
  rmSync(codexHome, { recursive: true, force: true });
  readRolloutDeltaSpy.mockReset();
  scanRolloutPrefixSpy.mockReset();
  commitCodexContextSummarySpy.mockReset();
  vi.useRealTimers();
});

describe('codex transcript capture', () => {
  it('observes only appended lines while recording partial physical rollout growth once', async () => {
    const first = tokenLine(1234);
    const file = writeRollout([first]);
    const initialBytes = Buffer.byteLength(`${first}\n`);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenLastCalledWith(
      sessionId,
      expect.objectContaining({
        lastToken: expect.objectContaining({ inputTokens: 1234 }),
        completeOffset: initialBytes,
        rolloutBytes: initialBytes,
        rolloutIdentity: expect.any(String),
      }),
    );

    appendFileSync(file, 'partial');
    const partialBytes = initialBytes + Buffer.byteLength('partial');
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenLastCalledWith(
      sessionId,
      expect.objectContaining({
        compactionCount: 0,
        firstToken: null,
        rolloutBytes: partialBytes,
      }),
    );
    expect(getCodexContextState(sessionId).rolloutBytes).toBe(partialBytes);

    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(2);

    const second = tokenLine(4321);
    appendFileSync(file, `\n${second}\n`);
    const finalBytes = partialBytes + Buffer.byteLength(`\n${second}\n`);
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenLastCalledWith(
      sessionId,
      expect.objectContaining({
        lastToken: expect.objectContaining({ inputTokens: 4321 }),
        completeOffset: finalBytes,
        rolloutBytes: finalBytes,
      }),
    );
    expect(getCodexContextState(sessionId)).toMatchObject({
      inputTokens: 4321,
      rolloutBytes: finalBytes,
    });
  });

  it('does not parse a truncated or missing rollout and durably commits its reset marker', async () => {
    const first = tokenLine(1234);
    const file = writeRollout([first]);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(1);

    writeFileSync(file, '');
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(1);

    rmSync(file);
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(2);
    expect(commitCodexContextSummarySpy).toHaveBeenLastCalledWith(
      sessionId,
      expect.objectContaining({
        completeOffset: 0,
        resetGeneration: true,
      }),
    );
    await pollCodexCaptureOnce(sessionId);
    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(2);
  });

  it('observes a token-only appended delta immediately without folding a turn', async () => {
    writeRollout([
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1234, cached_input_tokens: 200 },
            model_context_window: 258400,
          },
        },
      }),
    ]);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(commitCodexContextSummarySpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        lastToken: expect.objectContaining({ inputTokens: 1234 }),
        rolloutBytes: expect.any(Number),
      }),
    );
    expect(getCodexContextState(sessionId)).toMatchObject({
      available: true,
      inputTokens: 1234,
      cachedInputTokens: 200,
      contextWindowTokens: 258400,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId)).toEqual({ n: 0 });
  });

  it('keeps compaction and its post-compaction token ordered within one delta', async () => {
    writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 500, cached_input_tokens: 300 },
            model_context_window: 258400,
          },
        },
      }),
    ]);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId)).toMatchObject({
      available: true,
      inputTokens: 500,
      observedCompactions: 1,
      postCompactionInputTokens: 500,
    });
  });

  it('persists turns when telemetry observation fails', async () => {
    writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'telemetry-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'telemetry-turn', last_agent_message: 'hi' },
      }),
    ]);
    commitCodexContextSummarySpy.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable');
    });

    startCodexCapture(sessionId, codexHome, null);
    const turn = awaitCodexTurn(sessionId, new AbortController().signal, 1000);
    await pollCodexCaptureOnce(sessionId);

    expect(getDb()
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid')
      .all(sessionId)).toEqual([{ content: 'hello' }, { content: 'hi' }]);
    await expect(turn).resolves.toBe('hi');
  });

  it('retries an uncommitted telemetry batch on the next idle poll', async () => {
    const line = tokenLine(2468);
    writeRollout([line]);
    const context = await vi.importActual<typeof import('../codex-context.js')>('../codex-context.js');
    commitCodexContextSummarySpy
      .mockReturnValueOnce({ committed: false, state: null })
      .mockImplementation(context.commitCodexContextSummary);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    expect(getCodexContextState(sessionId).available).toBe(false);

    await pollCodexCaptureOnce(sessionId);

    expect(commitCodexContextSummarySpy).toHaveBeenCalledTimes(2);
    expect(commitCodexContextSummarySpy.mock.calls[1]?.[1]).toMatchObject({
      lastToken: expect.objectContaining({ inputTokens: 2468 }),
    });
    expect(getCodexContextState(sessionId)).toMatchObject({
      available: true,
      inputTokens: 2468,
    });
  });

  it('does not double count pre-completion telemetry after capture stop and restart', async () => {
    writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'open-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      tokenLine(777),
    ]);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    expect(getCodexContextState(sessionId)).toMatchObject({
      inputTokens: 777,
      observedCompactions: 1,
      postCompactionInputTokens: 777,
    });
    stopCodexCapture(sessionId);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId)).toMatchObject({
      inputTokens: 777,
      observedCompactions: 1,
      postCompactionInputTokens: 777,
    });
  });

  it('advances the tail offset past complete malformed and blank lines', async () => {
    vi.useFakeTimers();
    const file = writeRollout(['', 'not json']);
    const consumed = Buffer.byteLength('\nnot json\n');

    startCodexCapture(sessionId, codexHome, null);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(readRolloutDeltaSpy).toHaveBeenCalledTimes(2);
    const firstTail = readRolloutDeltaSpy.mock.calls[0]?.[1];
    const secondTail = readRolloutDeltaSpy.mock.calls[1]?.[1];
    expect(firstTail).toBe(secondTail);
    expect(firstTail).toMatchObject({
      startOffset: 0,
      readPosition: consumed,
      completeOffset: consumed,
    });
  });

  it('immediately persists a migrated legacy integer cursor across a restart', () => {
    const rows = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-resume' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'hi' } }),
    ];
    writeRollout(rows);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run('2', sessionId);

    startCodexCapture(sessionId, codexHome, 'codex-resume');

    const cursor = getDb()
      .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
      .get(sessionId) as { c: string };
    expect(JSON.parse(cursor.c)).toEqual({
      l: 2,
      t: 0,
      b: Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`),
      r: expect.any(String),
      g: expect.any(String),
    });

    stopCodexCapture(sessionId);
    startCodexCapture(sessionId, codexHome, 'codex-resume');
    expect(scanRolloutPrefixSpy).toHaveBeenCalledTimes(1);
  });

  it('validates a compatible r-less JSON cursor once and persists its identity', () => {
    const rows = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'compatible-resume' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'captured' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }),
    ];
    const file = writeRollout(rows);
    const offset = Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({ l: 2, t: 0, b: offset }),
      sessionId,
    );

    startCodexCapture(sessionId, codexHome, 'compatible-resume');

    const identity = `${statSync(file).dev}:${statSync(file).ino}`;
    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).toMatchObject({
      l: 2,
      t: 0,
      b: offset,
      r: identity,
    });
    expect(scanRolloutPrefixSpy).toHaveBeenCalledTimes(1);
  });

  it('defers an r-less JSON cursor when its migration scan fails', async () => {
    const line = tokenLine(123);
    writeRollout([line]);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({ l: 1, t: 0, b: Buffer.byteLength(`${line}\n`) }),
      sessionId,
    );
    scanRolloutPrefixSpy.mockReturnValue(null);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(readRolloutDeltaSpy).not.toHaveBeenCalled();
  });

  it.each([
    '{"l":-1,"t":0,"b":0}',
    '{"l":1,"t":2,"b":10}',
    '{"l":1,"t":0,"b":0}',
    '{"l":9007199254740992,"t":0,"b":1}',
    '{"l":1,"t":0,"b":-1}',
  ])('rejects a corrupt JSON cursor without issuing a negative or inconsistent read: %s', async (cursor) => {
    const file = writeRollout([tokenLine(123)]);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?')
      .run(cursor, sessionId);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(readRolloutDeltaSpy).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ startOffset: 0 }),
    );
  });

  it('drops and immediately normalizes a corrupt durable telemetry summary', async () => {
    const file = writeRollout([tokenLine(616)]);
    const stat = statSync(file);
    const rolloutIdentity = `${stat.dev}:${stat.ino}`;
    const corruptPending = {
      rolloutIdentity,
      startOffset: 0,
      completeOffset: 0,
      rolloutBytes: 0,
      compactionCount: 0,
      lastToken: null,
      firstTokenAfterLastCompaction: null,
      resetGeneration: false,
      generationId: 'corrupt-generation',
      unexpected: 'raw-secret',
    };
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({
        l: 0,
        t: 0,
        b: 0,
        r: rolloutIdentity,
        g: 'safe-generation',
        p: corruptPending,
      }),
      sessionId,
    );

    startCodexCapture(sessionId, codexHome, null);

    const normalized = (getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor;
    expect(normalized).not.toContain('raw-secret');
    expect(JSON.parse(normalized)).toEqual({
      l: 0,
      t: 0,
      b: 0,
      r: rolloutIdentity,
      g: 'safe-generation',
    });

    await pollCodexCaptureOnce(sessionId);
    expect(getCodexContextState(sessionId).inputTokens).toBe(616);
  });

  it('persists a new rollout identity at zero before a larger inode replacement is folded', async () => {
    const oldLine = tokenLine(111);
    const file = writeRollout([oldLine]);
    const oldSize = Buffer.byteLength(`${oldLine}\n`);
    const oldStat = statSync(file);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({ l: 1, t: 0, b: oldSize, r: `${oldStat.dev}:${oldStat.ino}` }),
      sessionId,
    );
    renameSync(file, `${file}.old`);
    const replacement = [tokenLine(222), tokenLine(333), tokenLine(444)];
    writeFileSync(file, `${replacement.join('\n')}\n`);
    const replacementStat = statSync(file);
    const replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}`;

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).toMatchObject({
      l: 0,
      t: 0,
      b: 0,
      r: replacementIdentity,
    });

    stopCodexCapture(sessionId);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId).inputTokens).toBe(444);
    expect(readRolloutDeltaSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      startOffset: 0,
      rolloutIdentity: replacementIdentity,
    });
  });

  it('persists a same-inode truncation generation before stop and restart', async () => {
    const oldTurn = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-fold' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old reply' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'old-fold', last_agent_message: 'old reply' },
      }),
    ];
    const file = writeRollout(oldTurn);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    const identityBefore = `${statSync(file).dev}:${statSync(file).ino}`;

    writeFileSync(file, `${tokenLine(505)}\n`);
    await pollCodexCaptureOnce(sessionId);
    const resetCursor = JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor) as {
      b: number;
      r: string;
      p: CodexContextPendingSummary;
    };
    expect(resetCursor).toMatchObject({
      b: 0,
      r: identityBefore,
      p: { resetGeneration: true, completeOffset: 0 },
    });

    stopCodexCapture(sessionId);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId).inputTokens).toBe(505);
  });

  it('resets an incompatible larger replacement behind an r-less JSON cursor', async () => {
    const first = tokenLine(111);
    const file = writeRollout([first]);
    const oldSize = Buffer.byteLength(`${first}\n`);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({ l: 1, t: 0, b: oldSize }),
      sessionId,
    );
    renameSync(file, `${file}.old`);
    writeFileSync(file, `${tokenLine(222)}\n${tokenLine(333)}\n`);

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(readRolloutDeltaSpy.mock.calls[0]?.[1]).toMatchObject({
      startOffset: 0,
    });
    expect(getCodexContextState(sessionId).inputTokens).toBe(333);
  });

  it('persists identity for an empty r-less cursor before a later replacement', async () => {
    const file = writeRollout([tokenLine(111)]);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      JSON.stringify({ l: 0, t: 0, b: 0 }),
      sessionId,
    );
    startCodexCapture(sessionId, codexHome, null);
    const firstIdentity = `${statSync(file).dev}:${statSync(file).ino}`;
    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).toMatchObject({ r: firstIdentity });
    stopCodexCapture(sessionId);

    renameSync(file, `${file}.old`);
    writeFileSync(file, `${tokenLine(222)}\n${tokenLine(333)}\n`);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).toMatchObject({ b: 0 });
  });

  it('keeps telemetry failure state bounded and free of raw rollout content across many folds', async () => {
    const file = writeRollout([]);
    commitCodexContextSummarySpy.mockReturnValue({ committed: false, state: null });
    startCodexCapture(sessionId, codexHome, null);
    let firstPendingLength = 0;

    for (let turn = 0; turn < 40; turn++) {
      const secret = `raw-secret-${turn}-${'x'.repeat(2000)}`;
      appendFileSync(file, [
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${turn}` } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: secret } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
        tokenLine(1000 + turn),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: `turn-${turn}`, last_agent_message: secret },
        }),
      ].join('\n') + '\n');
      await pollCodexCaptureOnce(sessionId);
      const rawCursor = (getDb().prepare(
        'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
      ).get(sessionId) as { cursor: string }).cursor;
      if (turn === 0) firstPendingLength = rawCursor.length;
      expect(rawCursor).not.toContain('raw-secret');
      expect(rawCursor.length).toBeLessThan(firstPendingLength + 80);
    }

    const persisted = JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor) as {
      p?: { compactionCount?: number; lines?: unknown };
    };
    expect(persisted.p).toMatchObject({ compactionCount: 40 });
    expect(persisted.p).not.toHaveProperty('lines');
  });

  it('recovers a folded failed telemetry summary exactly once after stop and restart', async () => {
    const file = writeRollout([]);
    commitCodexContextSummarySpy.mockReturnValueOnce({ committed: false, state: null });
    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'recover-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      tokenLine(808),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'recover-turn', last_agent_message: 'done' },
      }),
    ].join('\n') + '\n');

    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    stopCodexCapture(sessionId);
    const context = await vi.importActual<typeof import('../codex-context.js')>('../codex-context.js');
    commitCodexContextSummarySpy.mockImplementation(context.commitCodexContextSummary);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId)).toMatchObject({
      inputTokens: 808,
      observedCompactions: 1,
      postCompactionInputTokens: 808,
    });
    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).not.toHaveProperty('p');
  });

  it('deduplicates a durable summary left behind after context commit succeeds', async () => {
    const file = writeRollout([]);
    commitCodexContextSummarySpy.mockReturnValueOnce({ committed: false, state: null });
    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'stale-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      tokenLine(909),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'stale-turn', last_agent_message: 'done' },
      }),
    ].join('\n') + '\n');
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);
    const cursor = JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor) as { p: CodexContextPendingSummary };

    expect(commitCodexContextSummary(sessionId, cursor.p).committed).toBe(true);
    stopCodexCapture(sessionId);
    const context = await vi.importActual<typeof import('../codex-context.js')>('../codex-context.js');
    commitCodexContextSummarySpy.mockImplementation(context.commitCodexContextSummary);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId).observedCompactions).toBe(1);
  });

  it('deduplicates a reset summary left behind after context commit succeeds', async () => {
    const file = writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'x'.repeat(2000) },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old' },
      }),
    ]);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    writeFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'reset-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      tokenLine(919),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'reset-turn', last_agent_message: 'done' },
      }),
    ].join('\n') + '\n');
    await pollCodexCaptureOnce(sessionId);

    commitCodexContextSummarySpy.mockReturnValue({ committed: false, state: null });
    await pollCodexCaptureOnce(sessionId);
    const cursor = JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor) as { p: CodexContextPendingSummary };
    expect(cursor.p).toMatchObject({
      resetGeneration: true,
      compactionCount: 1,
      lastToken: { inputTokens: 919 },
      generationId: expect.any(String),
    });

    const context = await vi.importActual<typeof import('../codex-context.js')>('../codex-context.js');
    expect(context.commitCodexContextSummary(sessionId, cursor.p)).toMatchObject({
      committed: true,
      state: { observedCompactions: 1 },
    });
    stopCodexCapture(sessionId);
    commitCodexContextSummarySpy.mockImplementation(context.commitCodexContextSummary);
    startCodexCapture(sessionId, codexHome, null);
    await pollCodexCaptureOnce(sessionId);

    expect(getCodexContextState(sessionId)).toMatchObject({
      inputTokens: 919,
      observedCompactions: 1,
      postCompactionInputTokens: 919,
    });
    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).not.toHaveProperty('p');
  });

  it('holds a legacy cursor pending through scan failures before retrying safely', async () => {
    vi.useFakeTimers();
    const rows = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-resume' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'already captured' } }),
    ];
    const file = writeRollout(rows);
    getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run('2', sessionId);
    const actual = await vi.importActual<typeof import('./rollout-tail.js')>('./rollout-tail.js');
    scanRolloutPrefixSpy
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => null)
      .mockImplementation(actual.scanRolloutPrefix);

    startCodexCapture(sessionId, codexHome, 'codex-resume');
    await vi.advanceTimersByTimeAsync(500);

    expect(readRolloutDeltaSpy).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId)).toEqual({ n: 0 });
    expect(
      getDb()
        .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ c: '2' });

    const db = getDb();
    const prepareSpy = vi.spyOn(db, 'prepare');
    await vi.advanceTimersByTimeAsync(500);

    expect(scanRolloutPrefixSpy).toHaveBeenCalledTimes(3);
    const migratedOffset = Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`);
    expect(readRolloutDeltaSpy).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ startOffset: migratedOffset }),
    );
    expect(prepareSpy.mock.calls.filter(([sql]) => sql.startsWith('UPDATE sessions SET last_captured_transcript_uuid'))).toHaveLength(1);
    expect(JSON.parse((db
      .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
      .get(sessionId) as { c: string }).c)).toEqual({
      l: 2,
      t: 0,
      b: migratedOffset,
      r: expect.any(String),
      g: expect.any(String),
    });

    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new reply' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'new reply' } }),
    ].join('\n') + '\n');
    await vi.advanceTimersByTimeAsync(500);

    expect(db
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid')
      .all(sessionId)).toEqual([{ content: 'new turn' }, { content: 'new reply' }]);
    prepareSpy.mockRestore();
  });

  it('ignores a stalled turn late completion and resolves only the matching new turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
    const onTurnComplete = vi.fn();
    const file = writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'old prompt' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old partial' } }),
    ]);

    startCodexCapture(sessionId, codexHome, null, onTurnComplete);
    await pollCodexCaptureOnce(sessionId);
    vi.setSystemTime(new Date('2026-08-11T00:00:07.000Z'));
    await pollCodexCaptureOnce(sessionId);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);

    let resolvedReply: string | null = null;
    const waiter = awaitCodexTurn(sessionId, new AbortController().signal, 30_000)
      .then((reply) => {
        resolvedReply = reply;
        return reply;
      });
    appendFileSync(file, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old late reply' },
    })}\n`);
    await pollCodexCaptureOnce(sessionId);

    expect(resolvedReply).toBeNull();
    expect(onTurnComplete).toHaveBeenCalledTimes(1);

    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new prompt' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new fresh reply' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'new-turn', last_agent_message: 'new exact reply' },
      }),
    ].join('\n') + '\n');
    await pollCodexCaptureOnce(sessionId);

    await expect(waiter).resolves.toBe('new exact reply');
    expect(onTurnComplete).toHaveBeenCalledTimes(2);
  });

  it('does not treat quiet housekeeping or a trailing assistant as an anonymous turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
    const onTurnComplete = vi.fn();
    const file = writeRollout([
      tokenLine(1234),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old trailing assistant' } }),
    ]);

    startCodexCapture(sessionId, codexHome, null, onTurnComplete);
    let resolvedReply: string | null = null;
    const waiter = awaitCodexTurn(sessionId, new AbortController().signal, 30_000)
      .then((reply) => {
        resolvedReply = reply;
        return reply;
      });
    await pollCodexCaptureOnce(sessionId);
    vi.setSystemTime(new Date('2026-08-11T00:00:07.000Z'));
    await pollCodexCaptureOnce(sessionId);

    expect(resolvedReply).toBeNull();
    expect(onTurnComplete).not.toHaveBeenCalled();

    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'fresh-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'fresh prompt' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'fresh assistant' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'fresh-turn', last_agent_message: 'fresh exact reply' },
      }),
    ].join('\n') + '\n');
    await pollCodexCaptureOnce(sessionId);

    await expect(waiter).resolves.toBe('fresh exact reply');
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves an active turn prefix across an interleaved late completion', async () => {
    const onTurnComplete = vi.fn();
    const file = writeRollout([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'B partial' } }),
    ]);

    startCodexCapture(sessionId, codexHome, null, onTurnComplete);
    let resolvedReply: string | null = null;
    const waiter = awaitCodexTurn(sessionId, new AbortController().signal, 30_000)
      .then((reply) => {
        resolvedReply = reply;
        return reply;
      });
    await pollCodexCaptureOnce(sessionId);

    appendFileSync(file, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-a', last_agent_message: 'A late' },
    })}\n`);
    await pollCodexCaptureOnce(sessionId);

    expect(resolvedReply).toBeNull();
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string | null }).cursor).toBeNull();

    appendFileSync(file, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-b', last_agent_message: 'B exact reply' },
    })}\n`);
    await pollCodexCaptureOnce(sessionId);

    await expect(waiter).resolves.toBe('B exact reply');
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor)).toMatchObject({ l: 4, t: 2 });
    expect(getDb().prepare(
      'SELECT content FROM messages WHERE session_id = ? ORDER BY rowid',
    ).all(sessionId)).toEqual([{ content: 'B partial' }]);
  });

  it.each([
    ['restored stalled IDs', false],
    ['an old JSON cursor without stalled IDs', true],
  ] as const)('keeps %s safe across restart when a completion arrives late', async (_label, stripStalledIds) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
    const file = writeRollout([
      JSON.stringify({ type: 'session_meta', payload: { id: 'restart-session' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old partial' } }),
    ]);
    startCodexCapture(sessionId, codexHome, 'restart-session', vi.fn());
    await pollCodexCaptureOnce(sessionId);
    vi.setSystemTime(new Date('2026-08-11T00:00:07.000Z'));
    await pollCodexCaptureOnce(sessionId);

    const cursor = JSON.parse((getDb().prepare(
      'SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?',
    ).get(sessionId) as { cursor: string }).cursor) as {
      l: number;
      t: number;
      b: number;
      s?: string[];
    };
    expect(cursor.s).toContain('old-turn');
    if (stripStalledIds) {
      getDb().prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?')
        .run(JSON.stringify({ l: cursor.l, t: cursor.t, b: cursor.b }), sessionId);
    }
    stopCodexCapture(sessionId);

    const onTurnComplete = vi.fn();
    startCodexCapture(sessionId, codexHome, 'restart-session', onTurnComplete);
    let resolvedReply: string | null = null;
    const waiter = awaitCodexTurn(sessionId, new AbortController().signal, 30_000)
      .then((reply) => {
        resolvedReply = reply;
        return reply;
      });
    appendFileSync(file, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old late reply' },
    })}\n`);
    await pollCodexCaptureOnce(sessionId);

    expect(resolvedReply).toBeNull();
    expect(onTurnComplete).not.toHaveBeenCalled();

    appendFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new assistant' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'new-turn', last_agent_message: 'new exact reply' },
      }),
    ].join('\n') + '\n');
    await pollCodexCaptureOnce(sessionId);

    await expect(waiter).resolves.toBe('new exact reply');
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });
});
