// SQLite-backed `WorkerStateAdapter` so a backend restart can resume the
// same bridge worker via `runAssistantWorker`'s `perpetual: true` path.
// One row per session in the `bridge_state` table (migration 20); the SDK
// calls `load()` at startup and `save()` at every checkpoint (turn
// boundary, reconnect, teardown).
//
// We do NOT touch sessions.claude_session_id from here — that column
// carries the local adapter's resume token. Bridge worker state is its
// own column set, populated only when remote-control is enabled.

import { getDb } from '../../db/connection.js';

// Mirrors the SDK's `WorkerState` shape from
// @anthropic-ai/claude-agent-sdk/assistant. Re-declared locally so the
// adapter file isn't the only place that has to know about the alpha
// type — and so this file stays compileable if the SDK ever renames
// fields.
export interface WorkerState {
  claudeSessionId?: string;
  lastSSESequenceNum?: number;
  bridgeSessionId?: string;
}

export interface WorkerStateAdapter {
  load(): Promise<WorkerState | null>;
  save(state: WorkerState): Promise<void>;
}

interface BridgeStateRow {
  session_id: string;
  bridge_session_id: string | null;
  claude_session_id: string | null;
  last_sse_seq: number | null;
  updated_at: string;
}

export function createWorkerStateAdapter(sessionId: string): WorkerStateAdapter {
  return {
    async load() {
      const row = getDb()
        .prepare('SELECT * FROM bridge_state WHERE session_id = ?')
        .get(sessionId) as BridgeStateRow | undefined;
      if (!row) return null;
      const state: WorkerState = {};
      if (row.claude_session_id) state.claudeSessionId = row.claude_session_id;
      if (row.bridge_session_id) state.bridgeSessionId = row.bridge_session_id;
      if (row.last_sse_seq !== null && row.last_sse_seq !== undefined) {
        state.lastSSESequenceNum = row.last_sse_seq;
      }
      return state;
    },
    async save(state) {
      // Upsert so the very first checkpoint (no prior row) and ongoing
      // updates share the same code path. updated_at is written from
      // Node, not SQLite's `CURRENT_TIMESTAMP`, to stay consistent with
      // the rest of pinloom's timestamp convention.
      //
      // The SDK calls save() asynchronously during teardown — which can
      // race the session-delete route. `cancelAiRun()` aborts the run
      // synchronously and `DELETE FROM sessions` runs on the next line,
      // but the SDK's teardown checkpoint may still fire after that.
      // The FK is gone by then, so the upsert would throw `FOREIGN KEY
      // constraint failed` from inside a callback the SDK doesn't catch.
      // Swallow that specific case — the session is gone, the state is
      // irrelevant. Real errors (disk full, schema mismatch) still
      // surface.
      try {
        getDb()
          .prepare(
            `INSERT INTO bridge_state
               (session_id, bridge_session_id, claude_session_id, last_sse_seq, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               bridge_session_id = excluded.bridge_session_id,
               claude_session_id = excluded.claude_session_id,
               last_sse_seq      = excluded.last_sse_seq,
               updated_at        = excluded.updated_at`,
          )
          .run(
            sessionId,
            state.bridgeSessionId ?? null,
            state.claudeSessionId ?? null,
            state.lastSSESequenceNum ?? null,
            new Date().toISOString(),
          );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('FOREIGN KEY')) return;
        throw err;
      }
    },
  };
}

/**
 * Drop persisted bridge state for a session. Called when the session is
 * deleted so the FK cascade doesn't have to (the cascade would already
 * fire from migration 20's FOREIGN KEY, but calling this explicitly lets
 * the caller invalidate any in-memory caches at the same point and
 * keeps the lifecycle obvious in the delete route).
 */
export function clearBridgeState(sessionId: string): void {
  getDb().prepare('DELETE FROM bridge_state WHERE session_id = ?').run(sessionId);
}
