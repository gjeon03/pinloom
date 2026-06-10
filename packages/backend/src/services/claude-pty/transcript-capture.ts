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

async function onStop(pinloomSessionId: string, payload: StopHookPayload): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state || !payload.transcriptPath) return;
  if (state.running) return;
  state.running = true;
  try {
    const db = getDb();

    // Record the claude session id as the resume token the first time we see it.
    if (state.agentSessionId !== payload.sessionId) {
      state.agentSessionId = payload.sessionId;
      db.prepare(
        'UPDATE sessions SET agent_session_id = ?, claude_session_id = ?, updated_at = ? WHERE id = ?',
      ).run(payload.sessionId, payload.sessionId, new Date().toISOString(), pinloomSessionId);
    }

    const lines = readLines(payload.transcriptPath);

    // Seed `seen` from the persisted cursor on the first turn after a restart so
    // we don't re-capture already-folded history.
    if (!state.seeded) {
      state.seeded = true;
      if (state.cursor) {
        for (const l of lines) {
          if (l.uuid) state.seen.add(l.uuid);
          if (l.uuid === state.cursor) break;
        }
      }
    }

    const turn = selectTurnLines(lines, state.seen);
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
      db.prepare(
        'UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?',
      ).run(lastUuid, pinloomSessionId);
    }

    // Only signal turn-complete (notification + team_wait wake) when this Stop
    // actually produced new content — avoids spurious notifications for a Stop we
    // already captured.
    if (persistedAny) {
      emitRunStatus(pinloomSessionId, 'finished');
      notifySessionIdle(pinloomSessionId);
    }
  } catch (err) {
    console.warn('[claude-pty] transcript capture failed for %s:', pinloomSessionId, err);
  } finally {
    state.running = false;
  }
}
