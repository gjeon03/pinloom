import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WebSocket } from 'ws';
import type { WsEvent } from '@pinloom/shared';

// vi.mock is hoisted above imports so runner.ts picks up the mock when it
// loads `query` from the SDK module.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';
import { cancelAiRun, sendUserMessage } from './runner.js';
import { subscribe, unsubscribe } from '../ws/hub.js';

const mockQuery = vi.mocked(query);

type QueryArgs = Parameters<typeof query>[0];
type QueryReturn = ReturnType<typeof query>;
type QueryImpl = (args: QueryArgs) => QueryReturn;

function setQueryImpl(impl: QueryImpl) {
  mockQuery.mockImplementation(impl as unknown as typeof query);
}

function emptyStream(): QueryReturn {
  return (async function* () {})() as unknown as QueryReturn;
}

function errorStream(err: Error): QueryReturn {
  return (async function* () {
    throw err;
  })() as unknown as QueryReturn;
}

function abortAwaitingStream(args: QueryArgs): QueryReturn {
  // Hangs forever until the abortController fires, then rejects so the runner
  // exits its for-await loop. Models the SDK's expected abort semantics.
  const ac = (args.options as { abortController?: AbortController }).abortController;
  return (async function* () {
    await new Promise<void>((_resolve, reject) => {
      if (!ac) return;
      if (ac.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      ac.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  })() as unknown as QueryReturn;
}

function seedProject(id: string, cwd = '/tmp/test-project') {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, 'Test', cwd, now, now);
}

function seedPlan(id: string, projectId: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO plans (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, 'Plan', 'draft', now, now);
}

function seedPlanItem(id: string, planId: string, title = 'Task') {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO plan_items (id, plan_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, planId, title, now, now);
}

function seedSession(id: string, projectId: string, planId: string | null = null) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'INSERT INTO sessions (id, project_id, plan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, projectId, planId, now, now);
}

interface CapturedEvents {
  events: WsEvent[];
  stop: () => void;
}

function captureEvents(channel: string): CapturedEvents {
  const events: WsEvent[] = [];
  const fakeSocket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      events.push(JSON.parse(data) as WsEvent);
    },
  };
  subscribe(channel, fakeSocket as unknown as WebSocket);
  return {
    events,
    stop: () => unsubscribe(channel, fakeSocket as unknown as WebSocket),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function isFinishedOrError(events: WsEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === 'run_status' &&
      (e.status === 'finished' || e.status === 'error'),
  );
}

beforeAll(() => {
  // Force migrations to run on the temp DB path set by test-setup.ts.
  getDb();
});

beforeEach(() => {
  mockQuery.mockReset();
  const db = getDb();
  // Order matters because of FKs.
  db.exec(`
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM plan_items;
    DELETE FROM plans;
    DELETE FROM projects;
  `);
});

afterEach(() => {
  // Safety net so a leaked in-flight run can't poison the next test.
  // (Tests are expected to wait for run_status finished/error themselves.)
});

describe('sendUserMessage — user message persistence', () => {
  it('persists the user message synchronously and returns it', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'hello world');

    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello world');
    expect(msg.sessionId).toBe('s1');
    expect(msg.planItemId).toBeNull();
    expect(msg.id).toBeTruthy();

    const row = getDb()
      .prepare(
        'SELECT id, role, content FROM messages WHERE session_id = ? AND role = ?',
      )
      .get('s1', 'user') as { id: string; role: string; content: string };
    expect(row.id).toBe(msg.id);
    expect(row.content).toBe('hello world');

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('throws when the session does not exist', async () => {
    await expect(sendUserMessage('nope', 'hi')).rejects.toThrow(/not found/);
  });

  it('passes the project cwd to the SDK as the working directory', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1', '/some/project/path');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const args = mockQuery.mock.calls[0][0] as QueryArgs;
    expect((args.options as { cwd?: string }).cwd).toBe('/some/project/path');
  });
});

describe('sendUserMessage — plan-item resolution', () => {
  it('binds the user message to a planItemId resolved from @<id>', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemxxxxxx', 'pl1', 'Wire up auth');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'work on @itemxxxxxx now');

    expect(msg.planItemId).toBe('itemxxxxxx');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('explicit planItemId argument wins over a mention in the body', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemAAAAAA', 'pl1');
    seedPlanItem('itemBBBBBB', 'pl1');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage(
      's1',
      'mentioning @itemAAAAAA but binding to B',
      'itemBBBBBB',
    );

    expect(msg.planItemId).toBe('itemBBBBBB');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('ignores @<id> mentions that do not match a real plan item', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemrealxx', 'pl1');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'mentioning @notarealxx');

    expect(msg.planItemId).toBeNull();
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });
});

describe('sendUserMessage — image counter', () => {
  it('increments next_image_number by the number of attached images', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'see these', null, [
      { mimeType: 'image/png', base64: 'aaaa' },
      { mimeType: 'image/jpeg', base64: 'bbbb' },
    ]);

    const row = getDb()
      .prepare('SELECT next_image_number FROM sessions WHERE id = ?')
      .get('s1') as { next_image_number: number };
    expect(row.next_image_number).toBe(3); // started at 1, +2 images

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('does not change next_image_number when no images are attached', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'no images');

    const row = getDb()
      .prepare('SELECT next_image_number FROM sessions WHERE id = ?')
      .get('s1') as { next_image_number: number };
    expect(row.next_image_number).toBe(1);

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });
});

describe('sendUserMessage — error and cancel paths', () => {
  it('persists [runner error] and broadcasts run_status:error when the SDK throws', async () => {
    setQueryImpl(() => errorStream(new Error('SDK explosion')));
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'try this');

    await waitFor(() =>
      cap.events.some(
        (e) => e.type === 'run_status' && e.status === 'error',
      ),
    );

    const sysRow = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'system'`,
      )
      .get('s1') as { content: string } | undefined;
    expect(sysRow?.content).toMatch(/\[runner error\] SDK explosion/);
    cap.stop();
  });

  it('persists [cancelled by user] when cancelAiRun is called mid-run', async () => {
    setQueryImpl(abortAwaitingStream);
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'long-running task');

    // Wait for the runner to actually call query() so the abortController is wired up.
    await waitFor(() => mockQuery.mock.calls.length > 0);
    expect(cancelAiRun('s1')).toBe(true);

    await waitFor(() =>
      cap.events.some(
        (e) =>
          e.type === 'run_status' &&
          e.status === 'error' &&
          e.error === 'cancelled',
      ),
    );

    const rows = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'system'`,
      )
      .all('s1') as { content: string }[];
    expect(rows.some((r) => r.content === '[cancelled by user]')).toBe(true);
    cap.stop();
  });
});
