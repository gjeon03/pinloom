import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CodexContextState, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { CodexRolloverError } from '../services/codex-rollover.js';
import { sessionRoutes } from './sessions.js';

let app: FastifyInstance;
let sequence = 0;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(sessionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  getDb().exec('DELETE FROM codex_context_state; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
});

function insertSession(): string {
  const id = `codex-context-session-${sequence++}`;
  const projectId = `codex-context-project-${sequence++}`;
  const now = '2026-08-11T00:00:00.000Z';
  const db = getDb();
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'Context project', `/tmp/${projectId}`, now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, projectId, now, now);
  return id;
}

function insertMessage(
  sessionId: string,
  id: string,
  createdAt: string,
  sourceMessageId: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO messages (
         id, session_id, role, content, source_message_id, created_at
       ) VALUES (?, ?, 'assistant', ?, ?, ?)`,
    )
    .run(id, sessionId, `content-${id}`, sourceMessageId, createdAt);
}

describe('GET /api/sessions/:sessionId/messages/page', () => {
  it('returns backward cursor pages in chronological order without mirrors, gaps, or duplicates', async () => {
    const sessionId = insertSession();
    for (let index = 0; index < 205; index++) {
      insertMessage(
        sessionId,
        `page-${index.toString().padStart(3, '0')}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      );
    }
    insertMessage(
      sessionId,
      'page-mirror',
      '2026-01-01T01:00:00.000Z',
      'page-204',
    );

    const newestResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page`,
    });
    expect(newestResponse.statusCode).toBe(200);
    const newest = newestResponse.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(newest.items.map((item) => item.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `page-${(index + 105).toString().padStart(3, '0')}`),
    );
    expect(newest.nextCursor).toEqual(expect.any(String));

    const middleResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?before=${encodeURIComponent(newest.nextCursor ?? '')}`,
    });
    const middle = middleResponse.json() as typeof newest;
    expect(middle.items.map((item) => item.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `page-${(index + 5).toString().padStart(3, '0')}`),
    );
    expect(middle.nextCursor).toEqual(expect.any(String));

    const oldestResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?before=${encodeURIComponent(middle.nextCursor ?? '')}`,
    });
    const oldest = oldestResponse.json() as typeof newest;
    expect(oldest.items.map((item) => item.id)).toEqual([
      'page-000',
      'page-001',
      'page-002',
      'page-003',
      'page-004',
    ]);
    expect(oldest.nextCursor).toBeNull();

    const ids = [...oldest.items, ...middle.items, ...newest.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(205);
    expect(ids).not.toContain('page-mirror');
  });

  it('uses rowid as the strict tie-breaker for identical timestamps', async () => {
    const sessionId = insertSession();
    const timestamp = '2026-08-12T01:02:03.000Z';
    insertMessage(sessionId, 'tie-1', timestamp);
    insertMessage(sessionId, 'tie-2', timestamp);
    insertMessage(sessionId, 'tie-3', timestamp);

    const newest = (await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?limit=2`,
    })).json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(newest.items.map((item) => item.id)).toEqual(['tie-2', 'tie-3']);

    const oldest = (await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?limit=2&before=${encodeURIComponent(newest.nextCursor ?? '')}`,
    })).json() as typeof newest;
    expect(oldest.items.map((item) => item.id)).toEqual(['tie-1']);
    expect(oldest.nextCursor).toBeNull();
  });

  it('supports the minimum and maximum limits', async () => {
    const sessionId = insertSession();
    for (let index = 0; index < 510; index++) {
      insertMessage(
        sessionId,
        `limit-${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      );
    }

    const one = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?limit=1`,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().items).toHaveLength(1);
    expect(one.json().nextCursor).toEqual(expect.any(String));

    const fiveHundred = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?limit=500`,
    });
    expect(fiveHundred.statusCode).toBe(200);
    expect(fiveHundred.json().items).toHaveLength(500);
    expect(fiveHundred.json().nextCursor).toEqual(expect.any(String));
  });

  it.each(['0', '501', '-1', '1.5', 'abc', '01'])(
    'rejects invalid limit %s',
    async (limit) => {
      const sessionId = insertSession();
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages/page?limit=${limit}`,
      });
      expect(response.statusCode).toBe(400);
    },
  );

  it.each([
    'not-base64url!',
    Buffer.from('not-json').toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: '', rowid: 1 })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: '2026-01-01', rowid: 0 })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: '2026-01-01', rowid: 1, extra: true })).toString('base64url'),
  ])('rejects invalid cursor %s', async (before) => {
    const sessionId = insertSession();
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/messages/page?before=${encodeURIComponent(before)}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('scopes a valid cursor query to the requested session', async () => {
    const firstSession = insertSession();
    const secondSession = insertSession();
    insertMessage(firstSession, 'scope-first-1', '2026-01-01T00:00:01.000Z');
    insertMessage(firstSession, 'scope-first-2', '2026-01-01T00:00:02.000Z');
    insertMessage(secondSession, 'scope-second', '2025-01-01T00:00:00.000Z');
    const firstPage = (await app.inject({
      method: 'GET',
      url: `/api/sessions/${firstSession}/messages/page?limit=1`,
    })).json() as { nextCursor: string };

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${secondSession}/messages/page?before=${encodeURIComponent(firstPage.nextCursor)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['scope-second']);
  });

  it('returns an empty page for empty and unknown sessions', async () => {
    const emptySession = insertSession();
    for (const sessionId of [emptySession, 'missing-session']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages/page`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
    }
  });
});

describe('GET /api/sessions/:sessionId/codex-context', () => {
  it('returns 404 for a missing session', async () => {
    expect(await app.inject({
      method: 'GET',
      url: '/api/sessions/missing/codex-context',
    })).toMatchObject({ statusCode: 404 });
  });

  it('returns an unavailable context DTO when telemetry has not been observed', async () => {
    const sessionId = insertSession();

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/codex-context`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId,
      available: false,
      inputTokens: null,
      cachedInputTokens: null,
      contextWindowTokens: null,
      observedCompactions: 0,
      postCompactionInputTokens: null,
      rolloutBytes: null,
      updatedAt: null,
    });
  });

  it('returns the shared DTO without exposing telemetry internals', async () => {
    const sessionId = insertSession();
    const updatedAt = '2026-08-11T01:02:03.000Z';
    getDb().prepare(
      `INSERT INTO codex_context_state (
        session_id, input_tokens, cached_input_tokens, context_window_tokens,
        observed_compactions, post_compaction_input_tokens, rollout_bytes,
        awaiting_post_compaction, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 500, 300, 258400, 2, 500, 9876, 0, updatedAt);
    const expected: CodexContextState = {
      sessionId,
      available: true,
      inputTokens: 500,
      cachedInputTokens: 300,
      contextWindowTokens: 258400,
      observedCompactions: 2,
      postCompactionInputTokens: 500,
      rolloutBytes: 9876,
      updatedAt,
    };

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/codex-context`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.json()).not.toHaveProperty('awaiting_post_compaction');
  });
});

describe('POST /api/sessions/:sessionId/rollover', () => {
  const created: Session = {
    id: 'fresh-session',
    projectId: 'project',
    planId: null,
    agent: 'codex',
    agentSessionId: null,
    claudeSessionId: null,
    title: 'Continued session',
    nextImageNumber: 1,
    lastSyncedMessageId: null,
    model: null,
    reasoningEffort: null,
    transport: 'terminal',
    botKind: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };

  async function createRolloverApp(
    rolloverSession: (sessionId: string) => Promise<Session>,
  ): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    await instance.register(sessionRoutes, { rolloverSession });
    await instance.ready();
    return instance;
  }

  it('returns the created Session from the injected rollover service', async () => {
    const rolloverSession = vi.fn(async () => created);
    const instance = await createRolloverApp(rolloverSession);
    try {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/sessions/source/rollover',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(created);
      expect(rolloverSession).toHaveBeenCalledWith('source');
    } finally {
      await instance.close();
    }
  });

  it.each([
    [400, 'invalid rollover source'],
    [404, 'session not found'],
    [409, 'session busy'],
    [502, 'checkpoint failed'],
  ])('maps a rollover error to status %i', async (status, message) => {
    const rolloverSession = vi.fn(async () => {
      throw new CodexRolloverError(status as 400 | 404 | 409 | 502, message);
    });
    const instance = await createRolloverApp(rolloverSession);
    try {
      const before = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
      const response = await instance.inject({
        method: 'POST',
        url: '/api/sessions/source/rollover',
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: message });
      expect((getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(before);
    } finally {
      await instance.close();
    }
  });
});
