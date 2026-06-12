// Background transcript capture for terminal-mode sessions. The human drives the
// claude TUI directly (display = the live terminal), but pinloom still needs the
// conversation in its SQLite messages table for history, pins, notifications, and
// team synthesis. On every Stop hook for a captured session we diff the new
// transcript lines and persist them as the SAME message rows the runner produces
// (user / assistant text / tool), then fire the turn-complete signal.
//
// Single-writer invariant: only terminal-transport sessions are captured here,
// and they are never runner-driven, so the runner and this capture never write
// the same session's messages. Idempotency comes from the per-session `seen`
// uuid set (+ the persisted last_captured_transcript_uuid cursor across restarts).

import { getDb } from '../../db/connection.js';
import {
  selectTurnLines,
  summarizeToolCall,
  SYNTHETIC_MODEL,
  type JsonlContentBlock,
} from '../claude-jsonl/index.js';
import { readLines } from './transcript.js';
import { getStopHookServer } from './shared-server.js';
import type { StopHookPayload } from './stop-hook-server.js';
import { persistMessage, emitRunStatus, notifySessionIdle } from '../runner.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function turnHasAssistantContent(turn: { type: string; message?: { content?: unknown } }[]): boolean {
  return turn.some(
    (l) =>
      l.type === 'assistant' &&
      Array.isArray(l.message?.content) &&
      (l.message?.content as unknown[]).length > 0,
  );
}

interface CaptureState {
  unregister: () => void;
  seen: Set<string>;
  seeded: boolean;
  /** Persisted capture cursor (last transcript uuid folded into messages). */
  cursor: string | null;
  /** Claude session id once known (the resume token). */
  agentSessionId: string | null;
  /** Re-entrancy guard so two Stops can't double-process. */
  running: boolean;
  /** True while a rescan tail is chasing a not-yet-flushed assistant reply. */
  rescanPending: boolean;
}

const captures = new Map<string, CaptureState>();

/** Begin capturing a terminal session's turns. Idempotent. */
export async function startCapture(
  pinloomSessionId: string,
  resumeSessionId: string | null,
): Promise<void> {
  if (captures.has(pinloomSessionId)) return;
  const cursorRow = getDb()
    .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
    .get(pinloomSessionId) as { c: string | null } | undefined;

  const state: CaptureState = {
    unregister: () => {},
    seen: new Set(),
    seeded: false,
    cursor: cursorRow?.c ?? null,
    agentSessionId: resumeSessionId,
    running: false,
    rescanPending: false,
  };
  captures.set(pinloomSessionId, state);

  const server = await getStopHookServer();
  state.unregister = server.onStop(pinloomSessionId, (payload) => {
    void onStop(pinloomSessionId, payload);
  });
}

export function stopCapture(pinloomSessionId: string): void {
  const state = captures.get(pinloomSessionId);
  if (!state) return;
  state.unregister();
  captures.delete(pinloomSessionId);
}

function blocksOf(line: { message?: { content?: unknown } }): JsonlContentBlock[] {
  const c = line.message?.content;
  return Array.isArray(c) ? (c as JsonlContentBlock[]) : [];
}

const EMPTY_SEEN: ReadonlySet<string> = new Set();

/**
 * Is the conversation "settled" — does the transcript's last real user/assistant
 * line belong to the assistant? A trailing USER line means a reply is still
 * coming (or flushing); a trailing ASSISTANT line means we've caught up. This is
 * the rescan's termination signal: it must keep chasing until the tail is a
 * reply, NOT merely until it sees some assistant text — otherwise a turn whose
 * Stop got dropped (re-entrancy guard) while an earlier rescan was draining would
 * leave its reply orphaned until the next turn. (`selectTurnLines` with an empty
 * seen-set applies the exact same noise/sidechain/synthetic filter as capture.)
 */
function transcriptTailIsAssistant(transcriptPath: string): boolean {
  const lines = selectTurnLines(readLines(transcriptPath), EMPTY_SEEN);
  return lines[lines.length - 1]?.type === 'assistant';
}

/**
 * Persist every not-yet-seen user/assistant/tool line and advance the cursor.
 * Idempotent via `state.seen` (a re-scan only writes lines that flushed since the
 * last pass). Returns whether anything was written.
 */
function persistNewLines(
  pinloomSessionId: string,
  state: CaptureState,
  transcriptPath: string,
): { persistedAny: boolean } {
  const db = getDb();
  const turn = selectTurnLines(readLines(transcriptPath), state.seen);
  let model: string | null = null;
  let persistedAny = false;

  for (const line of turn) {
    if (line.uuid) state.seen.add(line.uuid);
    if (line.type === 'user') {
      const c = line.message?.content;
      if (typeof c === 'string' && c.trim().length > 0) {
        persistMessage({
          sessionId: pinloomSessionId,
          planItemId: null,
          role: 'user',
          content: c,
          transcriptUuid: line.uuid ?? null,
        });
        persistedAny = true;
      }
    } else if (line.type === 'assistant') {
      const m = line.message?.model;
      if (m && m !== SYNTHETIC_MODEL) model = m;
      for (const block of blocksOf(line)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          persistMessage({
            sessionId: pinloomSessionId,
            planItemId: null,
            role: 'assistant',
            content: block.text,
            model,
            transcriptUuid: line.uuid ?? null,
          });
          persistedAny = true;
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          persistMessage({
            sessionId: pinloomSessionId,
            planItemId: null,
            role: 'tool',
            content: summarizeToolCall(name, input),
            toolUse: { name, input },
            transcriptUuid: line.uuid ?? null,
          });
          persistedAny = true;
        }
      }
    }
  }

  const lastUuid = turn.length > 0 ? turn[turn.length - 1].uuid : undefined;
  if (lastUuid) {
    state.cursor = lastUuid;
    db.prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      lastUuid,
      pinloomSessionId,
    );
  }

  return { persistedAny };
}

/** Notification + team_wait wake: this session's turn is complete. */
function signalTurnComplete(pinloomSessionId: string): void {
  emitRunStatus(pinloomSessionId, 'finished');
  notifySessionIdle(pinloomSessionId);
}

// Tail re-scan for the case where the Stop hook fired but the assistant reply
// hadn't flushed to the transcript yet. Without this the latest reply would only
// get captured on the NEXT turn's Stop — i.e. it'd be missing from history/pins
// until the user sent another message (the symptom we saw: panel stopped at the
// user line). Re-reads on a short interval until the assistant text lands.
//
// Driven purely by what's in the transcript, never by a payload field: claude's
// real Stop-hook input doesn't reliably carry the reply text, and a normal turn
// always ends with an assistant message — so "captured a user line but no reply
// yet" is itself the signal that a reply is still flushing.
const FLUSH_POLL_ATTEMPTS = 10; // ~1.2s in-handler fast path (kept short: holds the drain lock)
const RESCAN_INTERVAL_MS = 250;
const RESCAN_MAX_ATTEMPTS = 40; // ~10s tail beyond the in-handler poll

/** Start chasing a not-yet-flushed reply (no-op if a tail is already running). */
function startAssistantRescan(pinloomSessionId: string, transcriptPath: string): void {
  const state = captures.get(pinloomSessionId);
  if (!state || state.rescanPending) return;
  state.rescanPending = true;
  scheduleAssistantRescan(pinloomSessionId, transcriptPath, 0);
}

function scheduleAssistantRescan(
  pinloomSessionId: string,
  transcriptPath: string,
  attempt: number,
): void {
  setTimeout(() => {
    void runAssistantRescan(pinloomSessionId, transcriptPath, attempt);
  }, RESCAN_INTERVAL_MS);
}

async function runAssistantRescan(
  pinloomSessionId: string,
  transcriptPath: string,
  attempt: number,
): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state) return; // session torn down — drop the tail
  // A real Stop for the next turn may be mid-drain; retry the same attempt soon.
  if (state.running) {
    scheduleAssistantRescan(pinloomSessionId, transcriptPath, attempt);
    return;
  }
  state.running = true;
  let settled = false;
  try {
    persistNewLines(pinloomSessionId, state, transcriptPath);
    // Keep chasing until the conversation tail is a reply, not just until we saw
    // *some* assistant text — a later turn's user line may still be unanswered.
    settled = transcriptTailIsAssistant(transcriptPath);
  } catch (err) {
    console.warn('[claude-pty] late assistant re-scan failed for %s:', pinloomSessionId, err);
  } finally {
    state.running = false;
  }
  if (settled) {
    state.rescanPending = false;
    signalTurnComplete(pinloomSessionId);
    return;
  }
  if (attempt + 1 >= RESCAN_MAX_ATTEMPTS) {
    // Reply never flushed (aborted turn, or claude exited). Signal anyway so the
    // turn isn't left hanging for team_wait / notifications.
    state.rescanPending = false;
    signalTurnComplete(pinloomSessionId);
    return;
  }
  scheduleAssistantRescan(pinloomSessionId, transcriptPath, attempt + 1);
}

async function onStop(pinloomSessionId: string, payload: StopHookPayload): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state || !payload.transcriptPath) return;
  if (state.running) return;
  state.running = true;

  let persistedAny = false;
  let tailSettled = false;

  try {
    const db = getDb();

    // Record the claude session id as the resume token the first time we see it.
    if (state.agentSessionId !== payload.sessionId) {
      state.agentSessionId = payload.sessionId;
      db.prepare(
        'UPDATE sessions SET agent_session_id = ?, claude_session_id = ?, updated_at = ? WHERE id = ?',
      ).run(payload.sessionId, payload.sessionId, new Date().toISOString(), pinloomSessionId);
    }

    // Seed `seen` from the persisted cursor on the first turn after a restart so
    // we don't re-capture already-folded history.
    if (!state.seeded) {
      state.seeded = true;
      if (state.cursor) {
        for (const l of readLines(payload.transcriptPath)) {
          if (l.uuid) state.seen.add(l.uuid);
          if (l.uuid === state.cursor) break;
        }
      }
    }

    // claude flushes the completed assistant message to the transcript a beat
    // AFTER firing the Stop hook (measured), so a single read catches the user
    // line but misses the reply. Poll briefly for the reply; the rescan tail
    // below covers a flush slower than this window.
    let turn = selectTurnLines(readLines(payload.transcriptPath), state.seen);
    for (let i = 0; i < FLUSH_POLL_ATTEMPTS && !turnHasAssistantContent(turn); i++) {
      await sleep(120);
      turn = selectTurnLines(readLines(payload.transcriptPath), state.seen);
    }

    persistedAny = persistNewLines(pinloomSessionId, state, payload.transcriptPath).persistedAny;
    tailSettled = transcriptTailIsAssistant(payload.transcriptPath);
  } catch (err) {
    console.warn('[claude-pty] transcript capture failed for %s:', pinloomSessionId, err);
  } finally {
    state.running = false;
  }

  if (!tailSettled) {
    // The transcript ends on a user line — the reply is still flushing (or this
    // Stop fired before it). Chase it so the latest reply doesn't wait for the
    // next turn's Stop; the tail fires the turn-complete signal once it lands.
    startAssistantRescan(pinloomSessionId, payload.transcriptPath);
  } else if (persistedAny) {
    // Reply is in and we wrote new rows this Stop — turn complete. (A settled
    // tail with nothing new is a repeat Stop we already folded; stay quiet.)
    signalTurnComplete(pinloomSessionId);
  }
}
