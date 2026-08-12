import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@pinloom/shared';
import type { CodexRolloutLine } from './codex-rollout/parse.js';
import { getDb } from '../db/connection.js';
import {
  commitCodexContextSummary,
  commitCodexContextObservation,
  getCodexContextState,
  mergeCodexContextSummaries,
  isCodexContextPendingSummary,
  summarizeCodexContextObservation,
  observeCodexContext,
} from './codex-context.js';
import * as hub from '../ws/hub.js';

const validToken = {
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: { input_tokens: 193800, cached_input_tokens: 120000 },
      model_context_window: 258400,
    },
  },
} satisfies CodexRolloutLine;

const canonicalCompact = {
  type: 'event_msg',
  payload: { type: 'context_compacted' },
} satisfies CodexRolloutLine;

const compactNoise = { type: 'compacted', payload: { replacement_history: [] } } satisfies CodexRolloutLine;

function reset(): void {
  const db = getDb();
  db.exec('DELETE FROM codex_context_state; DELETE FROM sessions; DELETE FROM projects;');
  const now = '2026-08-11T00:00:00Z';
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('context-project', 'Context project', '/tmp/context-project', now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('context-session', 'context-project', now, now);
}

function captureEvents() {
  const events: WsEvent[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => events.push(JSON.parse(payload) as WsEvent),
  };
  return { events, socket: socket as unknown as Parameters<typeof hub.subscribe>[1] };
}

describe('codex context telemetry', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('does not report availability before a valid token sample', () => {
    expect(getCodexContextState('context-session')).toEqual({
      sessionId: 'context-session',
      available: false,
      inputTokens: null,
      cachedInputTokens: null,
      contextWindowTokens: null,
      observedCompactions: 0,
      postCompactionInputTokens: null,
      rolloutBytes: null,
      updatedAt: null,
    });

    const state = observeCodexContext('context-session', [canonicalCompact], 100);

    expect(state).toMatchObject({
      available: false,
      observedCompactions: 1,
      inputTokens: null,
    });
  });

  it('updates and broadcasts an existing row for a changed size-only observation', () => {
    observeCodexContext('context-session', [validToken], 1000);
    const { events, socket } = captureEvents();
    hub.subscribe('session:context-session', socket);
    try {
      expect(observeCodexContext('context-session', [], 1100)).toMatchObject({
        available: true,
        rolloutBytes: 1100,
      });
      expect(observeCodexContext('context-session', [], 1100)).toBeNull();
    } finally {
      hub.unsubscribe('session:context-session', socket);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'codex_context_updated',
      sessionId: 'context-session',
      context: { rolloutBytes: 1100 },
    });
  });

  it('does not create a telemetry row from a size-only observation', () => {
    expect(observeCodexContext('context-session', [], 1000)).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM codex_context_state').get()).toEqual({ n: 0 });
  });

  it('reduces canonical events in order and persists the post-compaction baseline', () => {
    expect(observeCodexContext('context-session', [validToken], 1000)).toMatchObject({
      available: true,
      inputTokens: 193800,
      cachedInputTokens: 120000,
      contextWindowTokens: 258400,
      observedCompactions: 0,
      postCompactionInputTokens: null,
      rolloutBytes: 1000,
    });

    expect(observeCodexContext('context-session', [compactNoise], 1100)).toMatchObject({
      rolloutBytes: 1100,
    });
    expect(getCodexContextState('context-session')).toMatchObject({
      observedCompactions: 0,
      rolloutBytes: 1100,
    });
    expect(observeCodexContext('context-session', [canonicalCompact], 1200)).toMatchObject({
      observedCompactions: 1,
      postCompactionInputTokens: null,
    });
    expect(
      getDb()
        .prepare('SELECT awaiting_post_compaction FROM codex_context_state WHERE session_id = ?')
        .get('context-session'),
    ).toEqual({ awaiting_post_compaction: 1 });

    const invalid = {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 0, cached_input_tokens: 0 },
          model_context_window: 258400,
        },
      },
    } satisfies CodexRolloutLine;
    expect(observeCodexContext('context-session', [invalid], 1300)).toMatchObject({
      rolloutBytes: 1300,
    });
    const malformed = {
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 'bad' } } },
    } satisfies CodexRolloutLine;
    expect(observeCodexContext('context-session', [malformed], 1350)).toMatchObject({
      rolloutBytes: 1350,
    });

    expect(
      getDb()
        .prepare('SELECT awaiting_post_compaction FROM codex_context_state WHERE session_id = ?')
        .get('context-session'),
    ).toEqual({ awaiting_post_compaction: 1 });

    const baseline = {
      ...validToken,
      payload: {
        ...validToken.payload,
        info: {
          last_token_usage: { input_tokens: 500, cached_input_tokens: 200 },
          model_context_window: 258400,
        },
      },
    } satisfies CodexRolloutLine;
    expect(observeCodexContext('context-session', [baseline], 1400)).toMatchObject({
      inputTokens: 500,
      cachedInputTokens: 200,
      postCompactionInputTokens: 500,
      rolloutBytes: 1400,
    });
    expect(
      getDb()
        .prepare('SELECT awaiting_post_compaction FROM codex_context_state WHERE session_id = ?')
        .get('context-session'),
    ).toEqual({ awaiting_post_compaction: 0 });

    expect(getCodexContextState('context-session')).toMatchObject({
      available: true,
      inputTokens: 500,
      cachedInputTokens: 200,
      contextWindowTokens: 258400,
      observedCompactions: 1,
      postCompactionInputTokens: 500,
      rolloutBytes: 1400,
    });
  });

  it('captures a baseline when compaction and a valid token arrive in one ordered delta', () => {
    observeCodexContext('context-session', [validToken], 1000);
    const baseline = {
      ...validToken,
      payload: {
        ...validToken.payload,
        info: {
          last_token_usage: { input_tokens: 700, cached_input_tokens: 300 },
          model_context_window: 258400,
        },
      },
    } satisfies CodexRolloutLine;

    expect(
      observeCodexContext('context-session', [canonicalCompact, baseline], 1500),
    ).toMatchObject({
      inputTokens: 700,
      observedCompactions: 1,
      postCompactionInputTokens: 700,
    });
    expect(
      getDb()
        .prepare('SELECT awaiting_post_compaction FROM codex_context_state WHERE session_id = ?')
        .get('context-session'),
    ).toEqual({ awaiting_post_compaction: 0 });
  });

  it('ignores negative, non-finite, and fractional token counts', () => {
    observeCodexContext('context-session', [validToken], 1000);
    const invalidSamples = [
      { input_tokens: -1, cached_input_tokens: 0, model_context_window: 258400 },
      { input_tokens: 1, cached_input_tokens: Infinity, model_context_window: 258400 },
      { input_tokens: 1, cached_input_tokens: 0, model_context_window: 258400.5 },
    ].map(({ input_tokens, cached_input_tokens, model_context_window }) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens, cached_input_tokens },
          model_context_window,
        },
      },
    } satisfies CodexRolloutLine));

    for (const sample of invalidSamples) {
      expect(observeCodexContext('context-session', [sample], Number.NaN)).toBeNull();
    }
    expect(getCodexContextState('context-session')).toMatchObject({
      inputTokens: 193800,
      cachedInputTokens: 120000,
      contextWindowTokens: 258400,
      rolloutBytes: 1000,
    });
  });

  it('broadcasts one complete context DTO for a first valid token and skips a duplicate', () => {
    const { events, socket } = captureEvents();
    hub.subscribe('session:context-session', socket);
    try {
      const state = observeCodexContext('context-session', [validToken], 1000);
      expect(state).not.toBeNull();
      expect(events).toEqual([
        {
          type: 'codex_context_updated',
          sessionId: 'context-session',
          context: {
            sessionId: 'context-session',
            available: true,
            inputTokens: 193800,
            cachedInputTokens: 120000,
            contextWindowTokens: 258400,
            observedCompactions: 0,
            postCompactionInputTokens: null,
            rolloutBytes: 1000,
            updatedAt: state?.updatedAt ?? null,
          },
        },
      ]);

      expect(observeCodexContext('context-session', [validToken], 1000)).toBeNull();
      expect(events).toHaveLength(1);
    } finally {
      hub.unsubscribe('session:context-session', socket);
    }
  });

  it('contains DB write and broadcast failures without throwing', () => {
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO codex_context_state')) {
        throw new Error('write failed');
      }
      return originalPrepare(sql);
    });

    expect(() => observeCodexContext('context-session', [validToken], 1000)).not.toThrow();
    expect(getCodexContextState('context-session').available).toBe(false);

    vi.restoreAllMocks();
    const broadcastSpy = vi.spyOn(hub, 'broadcast').mockImplementation(() => {
      throw new Error('broadcast failed');
    });
    expect(() => observeCodexContext('context-session', [validToken], 1000)).not.toThrow();
    expect(broadcastSpy).toHaveBeenCalledWith('session:context-session', expect.objectContaining({
      type: 'codex_context_updated',
      sessionId: 'context-session',
    }));
    expect(getCodexContextState('context-session').available).toBe(true);
  });

  it('persists internal pending changes without broadcasting an identical external state', () => {
    observeCodexContext('context-session', [validToken], 1000);
    const db = getDb();
    db.prepare(
      `UPDATE codex_context_state
       SET awaiting_post_compaction = 1, post_compaction_input_tokens = input_tokens
       WHERE session_id = ?`,
    ).run('context-session');

    const { events, socket } = captureEvents();
    hub.subscribe('session:context-session', socket);
    try {
      expect(observeCodexContext('context-session', [validToken], 1000)).toMatchObject({
        inputTokens: 193800,
        postCompactionInputTokens: 193800,
      });
    } finally {
      hub.unsubscribe('session:context-session', socket);
    }

    expect(events).toEqual([]);
    expect(
      db.prepare('SELECT awaiting_post_compaction FROM codex_context_state WHERE session_id = ?')
        .get('context-session'),
    ).toEqual({ awaiting_post_compaction: 0 });
  });

  it('deduplicates a replayed fold range across a service restart boundary', () => {
    const lines = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      canonicalCompact,
      {
        ...validToken,
        payload: {
          ...validToken.payload,
          info: {
            last_token_usage: { input_tokens: 700, cached_input_tokens: 300 },
            model_context_window: 258400,
          },
        },
      },
    ] satisfies CodexRolloutLine[];
    const observation = {
      lines,
      lineEnds: [100, 200, 300],
      completeOffset: 300,
      rolloutIdentity: '7:41',
      rolloutBytes: 340,
    };

    expect(commitCodexContextObservation('context-session', observation)).toMatchObject({
      committed: true,
      state: {
        inputTokens: 700,
        observedCompactions: 1,
        postCompactionInputTokens: 700,
        rolloutBytes: 340,
      },
    });
    expect(commitCodexContextObservation('context-session', observation)).toMatchObject({
      committed: true,
      state: null,
    });
    expect(getCodexContextState('context-session')).toMatchObject({
      inputTokens: 700,
      observedCompactions: 1,
      postCompactionInputTokens: 700,
      rolloutBytes: 340,
    });
    expect(getDb().prepare(
      `SELECT rollout_identity, observed_complete_offset
       FROM codex_context_state WHERE session_id = ?`,
    ).get('context-session')).toEqual({
      rollout_identity: '7:41',
      observed_complete_offset: 300,
    });
  });

  it('commits context state and the observation offset atomically', () => {
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO codex_context_state')) {
        throw new Error('write failed');
      }
      return originalPrepare(sql);
    });

    const observation = {
      lines: [canonicalCompact, validToken],
      lineEnds: [100, 200],
      completeOffset: 200,
      rolloutIdentity: '7:42',
      rolloutBytes: 220,
    };
    expect(commitCodexContextObservation('context-session', observation)).toEqual({
      committed: false,
      state: null,
    });
    expect(getCodexContextState('context-session').observedCompactions).toBe(0);

    vi.restoreAllMocks();
    expect(commitCodexContextObservation('context-session', observation)).toMatchObject({
      committed: true,
      state: { observedCompactions: 1, postCompactionInputTokens: 193800 },
    });
    expect(getDb().prepare(
      'SELECT observed_complete_offset FROM codex_context_state WHERE session_id = ?',
    ).get('context-session')).toEqual({ observed_complete_offset: 200 });
  });

  it('starts a new observation generation for replacement and in-place truncation without resetting totals', () => {
    const first = {
      lines: [canonicalCompact, validToken],
      lineEnds: [100, 200],
      completeOffset: 200,
      rolloutIdentity: '7:43',
      rolloutBytes: 220,
    };
    commitCodexContextObservation('context-session', first);
    const firstGeneration = (getDb().prepare(
      'SELECT observation_generation AS generation FROM codex_context_state WHERE session_id = ?',
    ).get('context-session') as { generation: string }).generation;

    const replacement = {
      lines: [canonicalCompact],
      lineEnds: [80],
      completeOffset: 80,
      rolloutIdentity: '7:44',
      rolloutBytes: 80,
    };
    expect(commitCodexContextObservation('context-session', replacement)).toMatchObject({
      state: { observedCompactions: 2, rolloutBytes: 80 },
    });
    const replacementGeneration = (getDb().prepare(
      'SELECT observation_generation AS generation FROM codex_context_state WHERE session_id = ?',
    ).get('context-session') as { generation: string }).generation;
    expect(replacementGeneration).not.toBe(firstGeneration);

    const truncatedSameInode = {
      lines: [canonicalCompact],
      lineEnds: [40],
      completeOffset: 40,
      rolloutIdentity: '7:44',
      rolloutBytes: 40,
    };
    expect(commitCodexContextObservation('context-session', truncatedSameInode)).toMatchObject({
      state: { observedCompactions: 3, rolloutBytes: 40 },
    });
    const truncatedGeneration = (getDb().prepare(
      'SELECT observation_generation AS generation FROM codex_context_state WHERE session_id = ?',
    ).get('context-session') as { generation: string }).generation;
    expect(truncatedGeneration).not.toBe(replacementGeneration);
    expect(commitCodexContextObservation('context-session', truncatedSameInode)).toMatchObject({
      committed: true,
      state: null,
    });
    expect((getDb().prepare(
      'SELECT observation_generation AS generation FROM codex_context_state WHERE session_id = ?',
    ).get('context-session') as { generation: string }).generation).toBe(truncatedGeneration);
  });

  it('merges bounded summaries with the same ordered result as their raw event stream', () => {
    const beforeCompact = {
      ...validToken,
      payload: {
        ...validToken.payload,
        info: {
          last_token_usage: { input_tokens: 900, cached_input_tokens: 400 },
          model_context_window: 258400,
        },
      },
    } satisfies CodexRolloutLine;
    const afterCompact = {
      ...validToken,
      payload: {
        ...validToken.payload,
        info: {
          last_token_usage: { input_tokens: 300, cached_input_tokens: 100 },
          model_context_window: 258400,
        },
      },
    } satisfies CodexRolloutLine;
    const left = summarizeCodexContextObservation({
      lines: [beforeCompact, canonicalCompact],
      lineEnds: [100, 200],
      completeOffset: 200,
      rolloutIdentity: '8:51',
      rolloutBytes: 200,
    }, 0);
    const right = summarizeCodexContextObservation({
      lines: [afterCompact],
      lineEnds: [300],
      completeOffset: 300,
      rolloutIdentity: '8:51',
      rolloutBytes: 320,
    }, 200);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const merged = mergeCodexContextSummaries(left!, right!);

    expect(merged).toMatchObject({
      compactionCount: 1,
      firstToken: { inputTokens: 900 },
      lastToken: { inputTokens: 300 },
      firstTokenAfterLastCompaction: { inputTokens: 300 },
    });
    expect(commitCodexContextSummary('context-session', merged!)).toMatchObject({
      committed: true,
      state: {
        inputTokens: 300,
        observedCompactions: 1,
        postCompactionInputTokens: 300,
      },
    });
  });

  it('rejects a partially overlapping aggregate instead of applying it twice', () => {
    const first = summarizeCodexContextObservation({
      lines: [canonicalCompact, validToken],
      lineEnds: [100, 200],
      completeOffset: 200,
      rolloutIdentity: '8:52',
      rolloutBytes: 200,
    }, 0)!;
    expect(commitCodexContextSummary('context-session', first).committed).toBe(true);

    const overlapping = {
      ...first,
      startOffset: 100,
      completeOffset: 300,
      rolloutBytes: 300,
    };
    expect(commitCodexContextSummary('context-session', overlapping)).toEqual({
      committed: false,
      state: null,
    });
    expect(getCodexContextState('context-session').observedCompactions).toBe(1);
  });

  it('deduplicates a stale reset summary by logical observation generation', () => {
    const reset = summarizeCodexContextObservation({
      lines: [canonicalCompact, validToken],
      lineEnds: [100, 200],
      completeOffset: 200,
      rolloutIdentity: '8:60',
      rolloutBytes: 200,
    }, 0, true, 'generation-reset-1')!;

    expect(commitCodexContextSummary('context-session', reset)).toMatchObject({
      committed: true,
      state: { observedCompactions: 1 },
    });
    expect(commitCodexContextSummary('context-session', reset)).toEqual({
      committed: true,
      state: null,
    });
    expect(getCodexContextState('context-session').observedCompactions).toBe(1);

    const laterReset = summarizeCodexContextObservation({
      lines: [canonicalCompact],
      lineEnds: [50],
      completeOffset: 50,
      rolloutIdentity: '8:60',
      rolloutBytes: 50,
    }, 0, true, 'generation-reset-2')!;
    expect(commitCodexContextSummary('context-session', laterReset)).toMatchObject({
      committed: true,
      state: { observedCompactions: 2 },
    });
  });

  it('requires exact known fields in persisted pending summaries', () => {
    const valid = summarizeCodexContextObservation({
      lines: [validToken],
      lineEnds: [100],
      completeOffset: 100,
      rolloutIdentity: '8:61',
      rolloutBytes: 100,
    }, 0, false, 'generation-validator')!;
    expect(isCodexContextPendingSummary(valid)).toBe(true);

    const missingTokenField = { ...valid } as Record<string, unknown>;
    delete missingTokenField.firstToken;
    expect(isCodexContextPendingSummary(missingTokenField)).toBe(false);
    expect(isCodexContextPendingSummary({ ...valid, unexpected: true })).toBe(false);
    expect(isCodexContextPendingSummary({
      ...valid,
      firstToken: { ...valid.firstToken, extra: 1 },
    })).toBe(false);
  });
});
