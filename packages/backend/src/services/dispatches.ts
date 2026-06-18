// Dispatch job records — the durable, transport-agnostic source of truth for
// one orchestrator→worker turn (docs/teams-dispatch-redesign.md). One row per
// dispatch; the row id is the handle a long-running task is reconnected through.
//
// This module is deliberately "dumb": it owns the row lifecycle (create →
// running → done/failed/timeout/cancelled), an in-process wake for `team_wait`,
// and the recovery/prune sweeps. It does NOT know how any transport produces a
// reply — the SDK runner and the terminal capture/route call into the
// transition helpers from wherever they hold the completion signal. That keeps
// the "who reports completion" asymmetry (SDK turn_complete vs terminal Stop +
// transcript capture) out of this file.

import { nanoid } from 'nanoid';
import { getDb } from '../db/connection.js';

export type DispatchState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'cancelled';

// Local subset of agent stop reasons (pinloom runs bypassPermissions, so the
// cloud `requires_action` family doesn't apply).
export type DispatchStopReason = 'end_turn' | 'error' | 'aborted';

export interface DispatchRow {
  id: string;
  team_id: string;
  worker_session_id: string;
  orchestrator_session_id: string | null;
  idempotency_key: string | null;
  prompt: string;
  state: DispatchState;
  stop_reason: DispatchStopReason | null;
  reply: string | null;
  error: string | null;
  last_progress: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set([
  'done',
  'failed',
  'timeout',
  'cancelled',
]);

export function isTerminalState(state: DispatchState): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// In-process wake for team_wait / team_ask. Keyed by dispatch id; fired the
// instant a row reaches a terminal state. Mirrors runner.ts's idleListeners
// pattern — subscribe BEFORE checking current state to avoid a lost-wakeup
// race between the check and the subscribe.
// ---------------------------------------------------------------------------
const terminalListeners = new Map<string, Set<() => void>>();

function notifyTerminal(dispatchId: string): void {
  const set = terminalListeners.get(dispatchId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb();
    } catch {
      // best-effort — one bad listener shouldn't break the rest
    }
  }
}

// ---------------------------------------------------------------------------
// Row reads
// ---------------------------------------------------------------------------
export function getDispatch(id: string): DispatchRow | undefined {
  return getDb()
    .prepare('SELECT * FROM dispatches WHERE id = ?')
    .get(id) as DispatchRow | undefined;
}

// The worker's most recent dispatch — drives team_status/team_read when the
// caller passes an alias (vs a specific dispatch id).
export function getLatestDispatchForWorker(
  workerSessionId: string,
): DispatchRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM dispatches
       WHERE worker_session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workerSessionId) as DispatchRow | undefined;
}

// A worker runs one dispatch at a time. This is the row backing the "is a
// dispatch in flight for this worker" reservation that replaces #110's lock.
export function getLiveDispatchForWorker(
  workerSessionId: string,
): DispatchRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM dispatches
       WHERE worker_session_id = ? AND state IN ('queued','running')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workerSessionId) as DispatchRow | undefined;
}

export function hasLiveDispatch(workerSessionId: string): boolean {
  return getLiveDispatchForWorker(workerSessionId) !== undefined;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface CreateDispatchArgs {
  teamId: string;
  workerSessionId: string;
  orchestratorSessionId?: string | null;
  prompt: string;
  idempotencyKey?: string | null;
  // Reservation semantics: a dispatch is born 'running' (the row IS the busy
  // marker the instant team_send/team_ask is accepted). 'queued' exists in the
  // state machine for a future queue-unification phase; P1 never uses it.
  state?: Extract<DispatchState, 'queued' | 'running'>;
}

export function createDispatch(args: CreateDispatchArgs): DispatchRow {
  const id = nanoid();
  const now = new Date().toISOString();
  const state: DispatchState = args.state ?? 'running';
  const startedAt = state === 'running' ? now : null;
  // Enforce the one-live-dispatch-per-worker invariant: a worker runs one turn
  // at a time, and the queue drain interrupts any in-flight turn anyway, so a
  // new dispatch supersedes a still-live prior one. Without this, the prior row
  // would orphan as a permanent 'running' (prune only reclaims terminal rows)
  // and getLiveDispatchForWorker would mis-resolve. Waiters on the superseded
  // dispatch wake with state=cancelled.
  const prior = getDb()
    .prepare(
      `SELECT id FROM dispatches
       WHERE worker_session_id = ? AND state IN ('queued','running')`,
    )
    .all(args.workerSessionId) as Array<{ id: string }>;
  if (prior.length > 0) {
    getDb()
      .prepare(
        `UPDATE dispatches
           SET state = 'cancelled', stop_reason = 'aborted',
               error = COALESCE(error, 'superseded by a newer dispatch'),
               ended_at = ?, updated_at = ?
         WHERE worker_session_id = ? AND state IN ('queued','running')`,
      )
      .run(now, now, args.workerSessionId);
    for (const p of prior) notifyTerminal(p.id);
  }
  getDb()
    .prepare(
      `INSERT INTO dispatches
         (id, team_id, worker_session_id, orchestrator_session_id,
          idempotency_key, prompt, state, stop_reason, reply, error,
          last_progress, created_at, started_at, ended_at, updated_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      args.teamId,
      args.workerSessionId,
      args.orchestratorSessionId ?? null,
      args.idempotencyKey ?? null,
      args.prompt,
      state,
      now,
      startedAt,
      now,
    );
  return getDispatch(id)!;
}

// ---------------------------------------------------------------------------
// Transitions. Terminal transitions are no-ops if the row is already terminal
// (idempotent — a late capture-backfill or a racing sweep can't resurrect or
// double-fire a finished dispatch).
// ---------------------------------------------------------------------------
function applyTerminal(
  id: string,
  state: Extract<DispatchState, 'done' | 'failed' | 'timeout' | 'cancelled'>,
  fields: { reply?: string | null; error?: string | null; stopReason?: DispatchStopReason | null },
): DispatchRow | undefined {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE dispatches
         SET state = ?,
             reply = COALESCE(?, reply),
             error = COALESCE(?, error),
             stop_reason = COALESCE(?, stop_reason),
             ended_at = ?,
             updated_at = ?
       WHERE id = ? AND state IN ('queued','running')`,
    )
    .run(
      state,
      fields.reply ?? null,
      fields.error ?? null,
      fields.stopReason ?? null,
      now,
      now,
      id,
    );
  if (result.changes === 0) return getDispatch(id); // already terminal
  notifyTerminal(id);
  return getDispatch(id);
}

export function markRunning(id: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE dispatches
         SET state = 'running',
             started_at = COALESCE(started_at, ?),
             updated_at = ?
       WHERE id = ? AND state = 'queued'`,
    )
    .run(now, now, id);
}

export function markDone(
  id: string,
  opts: { reply: string | null; stopReason?: DispatchStopReason },
): DispatchRow | undefined {
  return applyTerminal(id, 'done', {
    reply: opts.reply,
    stopReason: opts.stopReason ?? 'end_turn',
  });
}

export function markFailed(
  id: string,
  opts: { error: string; stopReason?: DispatchStopReason },
): DispatchRow | undefined {
  return applyTerminal(id, 'failed', {
    error: opts.error,
    stopReason: opts.stopReason ?? 'error',
  });
}

export function markTimeout(id: string): DispatchRow | undefined {
  // A timeout is not a failure of the work — the worker may still be running.
  // The handle stays valid; a later sweep / completion can still flip the row.
  // We DON'T move it to a terminal state here in P1: team_ask returning a
  // handle leaves the dispatch 'running' so a later team_wait still resolves.
  return getDispatch(id);
}

export function markCancelled(id: string): DispatchRow | undefined {
  return applyTerminal(id, 'cancelled', { stopReason: 'aborted' });
}

// Backfill a reply onto a live dispatch without necessarily completing it.
// Used by the terminal route once it has read the captured assistant reply.
export function setReply(id: string, reply: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE dispatches SET reply = ?, updated_at = ?
       WHERE id = ? AND state IN ('queued','running')`,
    )
    .run(reply, now, id);
}

// ---------------------------------------------------------------------------
// Wait for terminal state (team_wait / team_ask). Resolves with the terminal
// row, or null on timeout/abort (the dispatch stays live — caller returns a
// handle).
// ---------------------------------------------------------------------------
export function waitForTerminal(
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DispatchRow | null> {
  return new Promise<DispatchRow | null>((resolve) => {
    let settled = false;
    const set = terminalListeners.get(id) ?? new Set<() => void>();
    terminalListeners.set(id, set);

    function cleanup() {
      clearTimeout(timer);
      set.delete(onTerminal);
      if (set.size === 0) terminalListeners.delete(id);
      signal?.removeEventListener('abort', onAbort);
    }
    function settle(value: DispatchRow | null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function onTerminal() {
      const row = getDispatch(id);
      if (row && isTerminalState(row.state)) settle(row);
    }
    function onAbort() {
      settle(null);
    }

    // Subscribe BEFORE the early-out check (lost-wakeup guard).
    set.add(onTerminal);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => settle(null), timeoutMs);

    const current = getDispatch(id);
    if (!current) {
      settle(null);
      return;
    }
    if (isTerminalState(current.state)) settle(current);
  });
}

// ---------------------------------------------------------------------------
// Worker turn completion (SDK writer wiring, P1-c). The runner calls these
// from its turn-boundary chokepoints; they no-op when the worker has no live
// dispatch (a human typing directly into a worker chat, an orchestrator's own
// turn, a generalist session), so they're safe to call on every turn end.
//
// Reply authority is the messages table — the same rows the worker's chat UI
// shows — read at completion, so the dispatch reply always matches history.
// ---------------------------------------------------------------------------
function latestAssistantReply(
  workerSessionId: string,
  sinceISO: string,
): string | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM messages
       WHERE session_id = ? AND role = 'assistant' AND created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workerSessionId, sinceISO) as { content: string } | undefined;
  return row?.content ?? null;
}

export function completeLiveDispatchForWorker(workerSessionId: string): void {
  const live = getLiveDispatchForWorker(workerSessionId);
  if (!live) return;
  const since = live.started_at ?? live.created_at;
  markDone(live.id, { reply: latestAssistantReply(workerSessionId, since) });
}

export function failLiveDispatchForWorker(
  workerSessionId: string,
  error: string,
): void {
  const live = getLiveDispatchForWorker(workerSessionId);
  if (!live) return;
  markFailed(live.id, { error });
}

export function cancelLiveDispatchForWorker(workerSessionId: string): void {
  const live = getLiveDispatchForWorker(workerSessionId);
  if (!live) return;
  markCancelled(live.id);
}

// ---------------------------------------------------------------------------
// Recovery sweeps (P1-b). A non-terminal row whose producer is gone (backend
// restarted mid-turn, or the worker session was deleted) would otherwise
// strand team_wait forever — the wake can never arrive from a dead process.
// ---------------------------------------------------------------------------
function sweep(
  where: string,
  params: unknown[],
  error: string,
): number {
  const now = new Date().toISOString();
  const db = getDb();
  const rows = db
    .prepare(`SELECT id FROM dispatches WHERE state IN ('queued','running') AND ${where}`)
    .all(...params) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  db.prepare(
    `UPDATE dispatches
       SET state = 'failed', error = ?, stop_reason = 'aborted',
           ended_at = ?, updated_at = ?
     WHERE state IN ('queued','running') AND ${where}`,
  ).run(error, now, now, ...params);
  for (const r of rows) notifyTerminal(r.id);
  return rows.length;
}

// Called once on backend boot — every dispatch that was mid-flight when the
// previous process died is unrecoverable.
export function sweepStrandedDispatchesOnBoot(): number {
  return sweep('1 = 1', [], 'backend_restart');
}

// Called when a worker session is deleted — its live dispatch can never
// complete (the producer is gone).
export function sweepDispatchesForDeletedWorker(workerSessionId: string): number {
  return sweep('worker_session_id = ?', [workerSessionId], 'worker_gone');
}

// ---------------------------------------------------------------------------
// Retention (open Q3). Keep the last N dispatches per worker; prune older ones
// on insert. Terminal-only — never prunes a live row.
// ---------------------------------------------------------------------------
export function pruneWorkerDispatches(
  workerSessionId: string,
  keepLast = 50,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM dispatches
       WHERE worker_session_id = ?
         AND state NOT IN ('queued','running')
         AND id NOT IN (
           SELECT id FROM dispatches
           WHERE worker_session_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )`,
    )
    .run(workerSessionId, workerSessionId, keepLast);
  return result.changes;
}
