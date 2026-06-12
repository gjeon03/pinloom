// Background rollout capture for codex terminal sessions — the codex analog of
// claude-pty/transcript-capture.ts. The human drives the codex TUI directly, but
// pinloom still needs the conversation in its SQLite messages table (history,
// pins, notifications, teams). Codex has no usable Stop hook (its hook-trust
// dialog blocks the headless TUI), so instead of a hook we POLL the session's
// rollout file and persist each turn when its `task_complete` boundary appears.
//
// Single-writer invariant: only codex-terminal sessions are captured here, never
// runner-driven, so the runner and this capture never write the same session's
// messages. Idempotency comes from a line-count cursor persisted in the existing
// `last_captured_transcript_uuid` column (repurposed as an opaque string cursor).

import { getDb } from '../../db/connection.js';
import { persistMessage, emitRunStatus, notifySessionIdle } from '../runner.js';
import { findRollout, readRolloutLines } from './rollout.js';
import {
  parseRolloutRows,
  rolloutSessionId,
  countTaskComplete,
  lastAgentMessage,
  type CodexRolloutLine,
} from '../codex-rollout/parse.js';

/**
 * Count the completed turns already folded into messages, from the persisted
 * line cursor. codex `resume` APPENDS to the SAME rollout file (verified on
 * 0.133.0), so the prefix `lines[0..cursor)` is exactly what we captured before
 * — its `task_complete` count is the turns-seen baseline. Rehydrating this is
 * what stops a resumed session's first poll from firing the dispatch waiter on
 * an ALREADY-captured turn (returning a stale reply) and from re-folding rows.
 */
function rehydrateTurnsSeen(codexHome: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const path = findRollout(codexHome);
  if (!path) return 0;
  return countTaskComplete(readRolloutLines(path).slice(0, cursor));
}

const POLL_MS = 500;

interface CaptureState {
  codexHome: string;
  rolloutPath: string | null;
  /** Lines folded into messages so far. */
  cursor: number;
  /** Completed turns folded so far (a new task_complete count means a new turn). */
  turnsSeen: number;
  /** codex session id (resume token) once known. */
  codexSessionId: string | null;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** One-shot waiters for the next completed turn (dispatch). */
  waiters: Array<(reply: string) => void>;
}

const captures = new Map<string, CaptureState>();

/** Begin polling a codex terminal session's rollout. Idempotent. */
export function startCodexCapture(
  pinloomSessionId: string,
  codexHome: string,
  resumeSessionId: string | null,
): void {
  if (captures.has(pinloomSessionId)) return;
  const cursorRow = getDb()
    .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
    .get(pinloomSessionId) as { c: string | null } | undefined;
  const cursor = cursorRow?.c ? Number.parseInt(cursorRow.c, 10) : 0;

  const safeCursor = Number.isFinite(cursor) ? cursor : 0;
  const state: CaptureState = {
    codexHome,
    rolloutPath: null,
    cursor: safeCursor,
    // On a resumed session the rollout already holds prior turns; baseline
    // turnsSeen to them so the next completed turn (not a captured one) is what
    // wakes dispatch waiters and gets folded.
    turnsSeen: rehydrateTurnsSeen(codexHome, safeCursor),
    codexSessionId: resumeSessionId,
    timer: null,
    running: false,
    waiters: [],
  };
  captures.set(pinloomSessionId, state);
  state.timer = setInterval(() => {
    void poll(pinloomSessionId);
  }, POLL_MS);
}

export function stopCodexCapture(pinloomSessionId: string): void {
  const state = captures.get(pinloomSessionId);
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  captures.delete(pinloomSessionId);
}

/**
 * Resolve with the reply text of the NEXT completed turn for this session — used
 * by dispatch (Phase 3). Rejects on abort/timeout.
 */
export function awaitCodexTurn(
  pinloomSessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state = captures.get(pinloomSessionId);
    if (!state) return reject(new Error('codex capture not started'));
    let done = false;
    const waiter = (reply: string) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(reply);
    };
    state.waiters.push(waiter);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`codex turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const s = captures.get(pinloomSessionId);
      if (s) {
        const i = s.waiters.indexOf(waiter);
        if (i !== -1) s.waiters.splice(i, 1);
      }
    }
  });
}

async function poll(pinloomSessionId: string): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state || state.running) return;
  state.running = true;
  try {
    if (!state.rolloutPath) {
      state.rolloutPath = findRollout(state.codexHome);
      if (!state.rolloutPath) return;
    }
    const lines = readRolloutLines(state.rolloutPath);
    const totalTurns = countTaskComplete(lines);
    if (totalTurns <= state.turnsSeen) return; // no newly-completed turn

    // Persist everything up to and including the last completed turn. Cut after
    // the final task_complete so a half-written next turn isn't folded early.
    const cut = lastTaskCompleteIndex(lines) + 1;
    const fresh = lines.slice(state.cursor, cut);
    const rows = parseRolloutRows(fresh);

    const db = getDb();
    if (!state.codexSessionId) {
      const sid = rolloutSessionId(lines);
      if (sid) {
        state.codexSessionId = sid;
        db.prepare(
          'UPDATE sessions SET agent_session_id = ?, claude_session_id = ?, updated_at = ? WHERE id = ?',
        ).run(sid, sid, new Date().toISOString(), pinloomSessionId);
      }
    }

    for (const r of rows) {
      persistMessage({
        sessionId: pinloomSessionId,
        planItemId: null,
        role: r.role,
        content: r.content,
        toolUse: r.toolUse,
      });
    }

    state.cursor = cut;
    state.turnsSeen = totalTurns;
    db.prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      String(cut),
      pinloomSessionId,
    );

    emitRunStatus(pinloomSessionId, 'finished');
    notifySessionIdle(pinloomSessionId);

    // Wake dispatch waiters with this turn's reply.
    if (state.waiters.length > 0) {
      const reply = lastAgentMessage(lines) ?? '';
      const waiters = state.waiters.splice(0);
      for (const w of waiters) w(reply);
    }
  } catch (err) {
    console.warn('[codex-pty] rollout capture failed for %s:', pinloomSessionId, err);
  } finally {
    state.running = false;
  }
}

function lastTaskCompleteIndex(lines: CodexRolloutLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type === 'event_msg' && (l.payload as { type?: string } | undefined)?.type === 'task_complete') {
      return i;
    }
  }
  return -1;
}
