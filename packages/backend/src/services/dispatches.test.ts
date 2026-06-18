import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import {
  cancelLiveDispatchForWorker,
  completeLiveDispatchForWorker,
  createDispatch,
  failLiveDispatchForWorker,
  getDispatch,
  getLatestDispatchForWorker,
  getLiveDispatchForWorker,
  hasLiveDispatch,
  markDone,
  markFailed,
  pruneWorkerDispatches,
  sweepDispatchesForDeletedWorker,
  sweepStrandedDispatchesOnBoot,
  waitForTerminal,
} from './dispatches.js';

const TEAM = 'team1';
const ORCH = 'orch1';
const WORKER = 'worker1';

function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('p1', 'Test', '/tmp/t', now, now);
  for (const id of [ORCH, WORKER, 'worker2']) {
    db.prepare(
      'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, 'p1', now, now);
  }
  db.prepare(
    'INSERT INTO teams (id, name, orchestrator_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(TEAM, 'Team', ORCH, now, now);
}

function seedAssistantMessage(sessionId: string, content: string, at?: string) {
  const db = getDb();
  const created = at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'assistant', ?, ?)`,
  ).run(`m-${Math.random().toString(36).slice(2)}`, sessionId, content, created);
}

function newDispatch(worker = WORKER, prompt = 'do it') {
  return createDispatch({
    teamId: TEAM,
    workerSessionId: worker,
    orchestratorSessionId: ORCH,
    prompt,
  });
}

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM dispatches;
    DELETE FROM messages;
    DELETE FROM teams;
    DELETE FROM sessions;
    DELETE FROM projects;
  `);
  seed();
});

describe('createDispatch', () => {
  it('creates a running row with started_at set', () => {
    const d = newDispatch();
    expect(d.state).toBe('running');
    expect(d.started_at).not.toBeNull();
    expect(d.reply).toBeNull();
    expect(getLiveDispatchForWorker(WORKER)?.id).toBe(d.id);
    expect(hasLiveDispatch(WORKER)).toBe(true);
  });

  it('supersedes a prior live dispatch (one-live-per-worker)', () => {
    const a = newDispatch();
    const b = newDispatch();
    expect(getDispatch(a.id)?.state).toBe('cancelled');
    expect(getDispatch(b.id)?.state).toBe('running');
    expect(getLiveDispatchForWorker(WORKER)?.id).toBe(b.id);
  });

  it('does not supersede a different worker', () => {
    const a = newDispatch(WORKER);
    const b = newDispatch('worker2');
    expect(getDispatch(a.id)?.state).toBe('running');
    expect(getDispatch(b.id)?.state).toBe('running');
  });
});

describe('transitions', () => {
  it('markDone stores reply + end_turn and is idempotent', () => {
    const d = newDispatch();
    markDone(d.id, { reply: 'answer' });
    const row = getDispatch(d.id)!;
    expect(row.state).toBe('done');
    expect(row.reply).toBe('answer');
    expect(row.stop_reason).toBe('end_turn');
    expect(row.ended_at).not.toBeNull();
    // second terminal transition is a no-op (can't resurrect/overwrite)
    markFailed(d.id, { error: 'late' });
    expect(getDispatch(d.id)?.state).toBe('done');
  });

  it('markFailed stores error', () => {
    const d = newDispatch();
    markFailed(d.id, { error: 'boom' });
    const row = getDispatch(d.id)!;
    expect(row.state).toBe('failed');
    expect(row.error).toBe('boom');
  });
});

describe('worker completion helpers', () => {
  it('completeLiveDispatchForWorker reads the latest assistant reply', () => {
    const d = newDispatch();
    seedAssistantMessage(WORKER, 'the reply');
    completeLiveDispatchForWorker(WORKER);
    const row = getDispatch(d.id)!;
    expect(row.state).toBe('done');
    expect(row.reply).toBe('the reply');
  });

  it('completeLiveDispatchForWorker is a no-op without a live dispatch', () => {
    expect(() => completeLiveDispatchForWorker(WORKER)).not.toThrow();
  });

  it('ignores assistant messages older than the dispatch', () => {
    seedAssistantMessage(WORKER, 'stale', '2000-01-01T00:00:00.000Z');
    const d = newDispatch();
    completeLiveDispatchForWorker(WORKER);
    // no message after start → reply null, but still completes
    const row = getDispatch(d.id)!;
    expect(row.state).toBe('done');
    expect(row.reply).toBeNull();
  });

  it('failLiveDispatchForWorker / cancelLiveDispatchForWorker', () => {
    const a = newDispatch();
    failLiveDispatchForWorker(WORKER, 'err');
    expect(getDispatch(a.id)?.state).toBe('failed');
    const b = newDispatch();
    cancelLiveDispatchForWorker(WORKER);
    expect(getDispatch(b.id)?.state).toBe('cancelled');
  });
});

describe('recovery sweeps', () => {
  it('sweepStrandedDispatchesOnBoot fails all live dispatches', () => {
    const a = newDispatch(WORKER);
    const b = newDispatch('worker2');
    const n = sweepStrandedDispatchesOnBoot();
    expect(n).toBe(2);
    expect(getDispatch(a.id)?.state).toBe('failed');
    expect(getDispatch(a.id)?.error).toBe('backend_restart');
    expect(getDispatch(b.id)?.state).toBe('failed');
  });

  it('sweepDispatchesForDeletedWorker only sweeps that worker', () => {
    const a = newDispatch(WORKER);
    const b = newDispatch('worker2');
    const n = sweepDispatchesForDeletedWorker(WORKER);
    expect(n).toBe(1);
    expect(getDispatch(a.id)?.state).toBe('failed');
    expect(getDispatch(a.id)?.error).toBe('worker_gone');
    expect(getDispatch(b.id)?.state).toBe('running');
  });

  it('boot sweep leaves terminal dispatches untouched', () => {
    const a = newDispatch();
    markDone(a.id, { reply: 'x' });
    const n = sweepStrandedDispatchesOnBoot();
    expect(n).toBe(0);
    expect(getDispatch(a.id)?.state).toBe('done');
  });
});

describe('retention', () => {
  it('pruneWorkerDispatches keeps the last N terminal rows', () => {
    for (let i = 0; i < 5; i++) {
      const d = newDispatch(WORKER, `p${i}`);
      markDone(d.id, { reply: `r${i}` });
    }
    const removed = pruneWorkerDispatches(WORKER, 2);
    expect(removed).toBe(3);
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM dispatches WHERE worker_session_id = ?')
      .get(WORKER) as { n: number };
    expect(remaining.n).toBe(2);
  });

  it('pruneWorkerDispatches never removes a live dispatch', () => {
    const live = newDispatch(WORKER);
    const removed = pruneWorkerDispatches(WORKER, 0);
    expect(removed).toBe(0);
    expect(getDispatch(live.id)?.state).toBe('running');
  });
});

describe('waitForTerminal', () => {
  it('resolves immediately if already terminal', async () => {
    const d = newDispatch();
    markDone(d.id, { reply: 'done' });
    const row = await waitForTerminal(d.id, 1000);
    expect(row?.state).toBe('done');
  });

  it('wakes when the dispatch completes', async () => {
    const d = newDispatch();
    const p = waitForTerminal(d.id, 2000);
    setTimeout(() => markDone(d.id, { reply: 'late answer' }), 20);
    const row = await p;
    expect(row?.reply).toBe('late answer');
  });

  it('wakes when superseded (cancelled)', async () => {
    const a = newDispatch();
    const p = waitForTerminal(a.id, 2000);
    setTimeout(() => newDispatch(), 20); // supersedes a
    const row = await p;
    expect(row?.state).toBe('cancelled');
  });

  it('resolves null on timeout while still running', async () => {
    const d = newDispatch();
    const row = await waitForTerminal(d.id, 30);
    expect(row).toBeNull();
    expect(getDispatch(d.id)?.state).toBe('running');
  });

  it('resolves null when aborted', async () => {
    const d = newDispatch();
    const ac = new AbortController();
    const p = waitForTerminal(d.id, 2000, ac.signal);
    ac.abort();
    expect(await p).toBeNull();
  });
});

describe('supersede semantics (review H1/scenario-4)', () => {
  it('a waiter on the superseded dispatch wakes with cancelled, not done', async () => {
    const a = newDispatch();
    const waiting = waitForTerminal(a.id, 2000);
    const b = newDispatch(); // supersedes a
    const row = await waiting;
    expect(row?.state).toBe('cancelled');
    expect(row?.reply).toBeNull();
    expect(row?.error).toMatch(/superseded/);
    // and b is the live one
    expect(getLiveDispatchForWorker(WORKER)?.id).toBe(b.id);
  });

  it('markDone on an already-superseded dispatch is a no-op (reply not resurrected)', () => {
    const a = newDispatch();
    newDispatch(); // supersedes a -> cancelled
    markDone(a.id, { reply: 'late terminal reply' });
    const row = getDispatch(a.id)!;
    expect(row.state).toBe('cancelled');
    expect(row.reply).toBeNull();
  });
});

describe('getLatestDispatchForWorker', () => {
  it('returns the most recent dispatch regardless of state', () => {
    const a = newDispatch();
    markDone(a.id, { reply: 'a' });
    const b = newDispatch();
    expect(getLatestDispatchForWorker(WORKER)?.id).toBe(b.id);
  });
});
