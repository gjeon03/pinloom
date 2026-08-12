// Incremental background transcript capture for terminal-mode Claude sessions.
// The live TUI remains the display and input owner; this service folds only new
// complete JSONL records into Pinloom messages and stores a crash-safe byte
// cursor so long sessions never require steady-state whole-file parsing.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { nanoid } from 'nanoid';
import type { Message, MessageRole } from '@pinloom/shared';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../ws/hub.js';
import {
  parseJsonlLine,
  selectTurnLines,
  summarizeToolCall,
  SYNTHETIC_MODEL,
  type JsonlContentBlock,
  type JsonlLine,
} from '../claude-jsonl/index.js';
import { emitRunStatus, notifySessionIdle } from '../runner.js';
import { recordSkillUse } from '../skill-usage.js';
import {
  createClaudeTranscriptTailState,
  readClaudeTranscriptDelta,
  type ClaudeTranscriptTailState,
} from './transcript-tail.js';
import { readCheckpoint, sessionFilePath } from './transcript.js';
import { getStopHookServer } from './shared-server.js';
import type { StopHookPayload } from './stop-hook-server.js';

const LEGACY_SCAN_CHUNK_SIZE = 1 << 20;
const FLUSH_POLL_ATTEMPTS = 10;
const RESCAN_INTERVAL_MS = 250;
const RESCAN_MAX_ATTEMPTS = 40;
const EMPTY_SEEN: ReadonlySet<string> = new Set();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ConversationType = 'user' | 'assistant';

interface DurableCaptureState {
  transcriptIdentity: string;
  completeOffset: number;
  lastTranscriptUuid: string | null;
  lastConversationType: ConversationType | null;
}

interface CaptureState {
  unregister: () => void;
  legacyCursor: string | null;
  durable: DurableCaptureState | null;
  tail: ClaudeTranscriptTailState | null;
  agentSessionId: string | null;
  running: boolean;
  rescanPending: boolean;
}

interface LegacyScanResult {
  found: boolean;
  transcriptIdentity: string;
  completeOffset: number;
  lastConversationType: ConversationType | null;
}

interface CaptureInsert {
  role: MessageRole;
  content: string;
  toolUse: unknown | null;
  model: string | null;
  transcriptUuid: string;
  skillName: string | null;
}

interface FoldResult {
  persistedAny: boolean;
  settled: boolean;
}

const captures = new Map<string, CaptureState>();

function isMeaningfulConversationLine(line: JsonlLine): line is JsonlLine & {
  type: ConversationType;
} {
  return selectTurnLines([line], EMPTY_SEEN).length === 1;
}

function blocksOf(line: JsonlLine): JsonlContentBlock[] {
  return Array.isArray(line.message?.content)
    ? (line.message.content as JsonlContentBlock[])
    : [];
}

function durableRow(pinloomSessionId: string): DurableCaptureState | null {
  const row = getDb()
    .prepare(
      `SELECT transcript_identity AS transcriptIdentity,
              complete_offset AS completeOffset,
              last_transcript_uuid AS lastTranscriptUuid,
              last_conversation_type AS lastConversationType
       FROM claude_transcript_state
       WHERE session_id = ?`,
    )
    .get(pinloomSessionId) as DurableCaptureState | undefined;
  return row ?? null;
}

function upsertDurableState(
  pinloomSessionId: string,
  value: DurableCaptureState,
  updatedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO claude_transcript_state (
         session_id, transcript_identity, complete_offset,
         last_transcript_uuid, last_conversation_type, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         transcript_identity = excluded.transcript_identity,
         complete_offset = excluded.complete_offset,
         last_transcript_uuid = excluded.last_transcript_uuid,
         last_conversation_type = excluded.last_conversation_type,
         updated_at = excluded.updated_at`,
    )
    .run(
      pinloomSessionId,
      value.transcriptIdentity,
      value.completeOffset,
      value.lastTranscriptUuid,
      value.lastConversationType,
      updatedAt,
    );
}

function persistBootstrapState(
  pinloomSessionId: string,
  state: CaptureState,
  value: DurableCaptureState,
): void {
  const db = getDb();
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    upsertDurableState(pinloomSessionId, value, updatedAt);
    db.prepare(
      'UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?',
    ).run(value.lastTranscriptUuid, pinloomSessionId);
  })();
  state.durable = value;
  state.legacyCursor = value.lastTranscriptUuid;
  state.tail = createClaudeTranscriptTailState(value.completeOffset, {
    transcriptIdentity: value.transcriptIdentity,
  });
}

/**
 * One-time bounded-memory scan used only to migrate a legacy UUID cursor to a
 * byte boundary. It stops as soon as the cursor record is complete.
 */
function scanLegacyCursor(file: string, targetUuid: string): LegacyScanResult | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }

  try {
    const stat = fstatSync(fd);
    const transcriptIdentity = `${stat.dev}:${stat.ino}`;
    const chunk = Buffer.allocUnsafe(LEGACY_SCAN_CHUNK_SIZE);
    const partial: Buffer[] = [];
    let partialLength = 0;
    let position = 0;
    let completeOffset = 0;
    let lastConversationType: ConversationType | null = null;

    while (position < stat.size) {
      const requested = Math.min(LEGACY_SCAN_CHUNK_SIZE, stat.size - position);
      const count = readSync(fd, chunk, 0, requested, position);
      if (count <= 0) return null;
      const chunkStart = position;
      position += count;
      let segmentStart = 0;
      while (segmentStart < count) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        if (newline < 0 || newline >= count) {
          const bytes = Buffer.from(chunk.subarray(segmentStart, count));
          partial.push(bytes);
          partialLength += bytes.length;
          break;
        }
        const bytes = Buffer.from(chunk.subarray(segmentStart, newline));
        partial.push(bytes);
        partialLength += bytes.length;
        completeOffset = chunkStart + newline + 1;
        const raw = partial.length === 1
          ? partial[0]
          : Buffer.concat(partial, partialLength);
        const line = parseJsonlLine(raw.toString('utf8'));
        partial.length = 0;
        partialLength = 0;
        if (line && isMeaningfulConversationLine(line)) {
          lastConversationType = line.type;
        }
        if (line?.uuid === targetUuid) {
          return {
            found: true,
            transcriptIdentity,
            completeOffset,
            lastConversationType,
          };
        }
        segmentStart = newline + 1;
      }
    }

    return {
      found: false,
      transcriptIdentity,
      completeOffset,
      lastConversationType,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function sourceMessageStats(pinloomSessionId: string): {
  total: number;
  withoutTranscriptUuid: number;
} {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN transcript_uuid IS NULL THEN 1 ELSE 0 END), 0)
                AS withoutTranscriptUuid
       FROM messages
       WHERE session_id = ? AND source_message_id IS NULL`,
    )
    .get(pinloomSessionId) as { total: number; withoutTranscriptUuid: number };
}

function bootstrapCaptureState(
  pinloomSessionId: string,
  state: CaptureState,
  transcriptPath: string,
): boolean {
  if (state.tail && state.durable) return true;

  const checkpoint = readCheckpoint(transcriptPath);
  if (!checkpoint) return false;

  const stats = sourceMessageStats(pinloomSessionId);
  let value: DurableCaptureState;
  if (state.legacyCursor) {
    const scan = scanLegacyCursor(transcriptPath, state.legacyCursor);
    if (!scan) return false;
    if (scan.found) {
      value = {
        transcriptIdentity: scan.transcriptIdentity,
        completeOffset: scan.completeOffset,
        lastTranscriptUuid: state.legacyCursor,
        lastConversationType: scan.lastConversationType,
      };
    } else if (stats.withoutTranscriptUuid === 0) {
      value = {
        transcriptIdentity: scan.transcriptIdentity,
        completeOffset: 0,
        lastTranscriptUuid: null,
        lastConversationType: null,
      };
    } else {
      console.warn(
        '[claude-pty] legacy cursor missing for %s; seeding at complete EOF to avoid ambiguous replay',
        pinloomSessionId,
      );
      value = {
        transcriptIdentity: checkpoint.transcriptIdentity,
        completeOffset: checkpoint.completeOffset,
        lastTranscriptUuid: checkpoint.uuid,
        lastConversationType: checkpoint.lastConversationType,
      };
    }
  } else if (stats.total > 0 && stats.withoutTranscriptUuid > 0) {
    console.warn(
      '[claude-pty] no legacy cursor for %s; seeding at complete EOF to avoid ambiguous replay',
      pinloomSessionId,
    );
    value = {
      transcriptIdentity: checkpoint.transcriptIdentity,
      completeOffset: checkpoint.completeOffset,
      lastTranscriptUuid: checkpoint.uuid,
      lastConversationType: checkpoint.lastConversationType,
    };
  } else {
    value = {
      transcriptIdentity: checkpoint.transcriptIdentity,
      completeOffset: 0,
      lastTranscriptUuid: null,
      lastConversationType: null,
    };
  }

  persistBootstrapState(pinloomSessionId, state, value);
  return true;
}

function captureInserts(lines: JsonlLine[]): CaptureInsert[] {
  const inserts: CaptureInsert[] = [];
  let model: string | null = null;
  for (const line of lines) {
    if (!line.uuid) continue;
    if (line.type === 'user') {
      const content = line.message?.content;
      if (typeof content === 'string' && content.trim()) {
        inserts.push({
          role: 'user',
          content,
          toolUse: null,
          model: null,
          transcriptUuid: line.uuid,
          skillName: null,
        });
      }
      continue;
    }
    if (line.type !== 'assistant') continue;
    if (line.message?.model && line.message.model !== SYNTHETIC_MODEL) {
      model = line.message.model;
    }
    let blockIndex = 0;
    for (const block of blocksOf(line)) {
      const transcriptUuid = blockIndex === 0 ? line.uuid : `${line.uuid}#${blockIndex}`;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        inserts.push({
          role: 'assistant',
          content: block.text,
          toolUse: null,
          model,
          transcriptUuid,
          skillName: null,
        });
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const input = (block.input ?? {}) as Record<string, unknown>;
        const skill = name === 'Skill' && typeof input.skill === 'string' ? input.skill : null;
        inserts.push({
          role: 'tool',
          content: summarizeToolCall(name, input),
          toolUse: { name, input },
          model,
          transcriptUuid,
          skillName: skill,
        });
      }
      blockIndex++;
    }
  }
  return inserts;
}

function commitDelta(
  pinloomSessionId: string,
  state: CaptureState,
  lines: JsonlLine[],
  completeOffset: number,
  transcriptIdentity: string,
): FoldResult {
  const db = getDb();
  const eligible = selectTurnLines(lines, EMPTY_SEEN);
  let lastTranscriptUuid = state.durable?.lastTranscriptUuid ?? null;
  let lastConversationType = state.durable?.lastConversationType ?? null;
  for (const line of eligible) {
    if (line.uuid) lastTranscriptUuid = line.uuid;
    lastConversationType = line.type as ConversationType;
  }
  const nextDurable: DurableCaptureState = {
    transcriptIdentity,
    completeOffset,
    lastTranscriptUuid,
    lastConversationType,
  };
  const inserts = captureInserts(eligible);
  const now = new Date().toISOString();

  const inserted = db.transaction(() => {
    const committed: Array<{ message: Message; skillName: string | null }> = [];
    for (const item of inserts) {
      const id = nanoid();
      const toolUse = item.toolUse === null ? null : JSON.stringify(item.toolUse);
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO messages
           (id, session_id, plan_item_id, role, content, tool_use, model,
            transcript_uuid, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          pinloomSessionId,
          item.role,
          item.content,
          toolUse,
          item.model,
          item.transcriptUuid,
          now,
        );
      if (info.changes > 0) {
        committed.push({
          message: {
            id,
            sessionId: pinloomSessionId,
            planItemId: null,
            role: item.role,
            content: item.content,
            toolUse,
            pinned: false,
            pinTitle: null,
            pinnedAt: null,
            sourceMessageId: null,
            model: item.model,
            createdAt: now,
          },
          skillName: item.skillName,
        });
      }
    }
    if (committed.length > 0) {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
        now,
        pinloomSessionId,
      );
    }
    upsertDurableState(pinloomSessionId, nextDurable, now);
    db.prepare(
      'UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?',
    ).run(lastTranscriptUuid, pinloomSessionId);
    return committed;
  })();

  state.durable = nextDurable;
  state.legacyCursor = lastTranscriptUuid;
  for (const item of inserted) {
    if (item.skillName) recordSkillUse(item.skillName, now);
    try {
      broadcast(`session:${pinloomSessionId}`, {
        type: 'message',
        sessionId: pinloomSessionId,
        message: item.message,
      });
    } catch (error) {
      console.warn('[claude-pty] message broadcast failed for %s:', pinloomSessionId, error);
    }
  }

  return {
    persistedAny: inserted.length > 0,
    settled: lastConversationType === 'assistant',
  };
}

function resetTailToDurable(state: CaptureState): void {
  if (!state.durable) {
    state.tail = null;
    return;
  }
  state.tail = createClaudeTranscriptTailState(state.durable.completeOffset, {
    transcriptIdentity: state.durable.transcriptIdentity,
  });
}

function persistGenerationReset(
  pinloomSessionId: string,
  state: CaptureState,
  transcriptIdentity: string,
): void {
  const next: DurableCaptureState = {
    transcriptIdentity,
    completeOffset: 0,
    lastTranscriptUuid: null,
    lastConversationType: null,
  };
  persistBootstrapState(pinloomSessionId, state, next);
}

function foldTranscript(
  pinloomSessionId: string,
  state: CaptureState,
  transcriptPath: string,
): FoldResult {
  if (!bootstrapCaptureState(pinloomSessionId, state, transcriptPath) || !state.tail) {
    return { persistedAny: false, settled: false };
  }

  let delta = readClaudeTranscriptDelta(transcriptPath, state.tail);
  if (delta.reset && delta.transcriptIdentity) {
    try {
      persistGenerationReset(pinloomSessionId, state, delta.transcriptIdentity);
    } catch (error) {
      resetTailToDurable(state);
      throw error;
    }
    if (!state.tail) return { persistedAny: false, settled: false };
    delta = readClaudeTranscriptDelta(transcriptPath, state.tail);
  }
  if (!delta.transcriptIdentity) {
    return {
      persistedAny: false,
      settled: state.durable?.lastConversationType === 'assistant',
    };
  }
  if (
    delta.completeOffset === state.durable?.completeOffset &&
    delta.lines.length === 0
  ) {
    return {
      persistedAny: false,
      settled: state.durable.lastConversationType === 'assistant',
    };
  }

  try {
    return commitDelta(
      pinloomSessionId,
      state,
      delta.lines,
      delta.completeOffset,
      delta.transcriptIdentity,
    );
  } catch (error) {
    resetTailToDurable(state);
    throw error;
  }
}

/** Begin capturing a terminal session's turns. Idempotent. */
export async function startCapture(
  pinloomSessionId: string,
  resumeSessionId: string | null,
): Promise<void> {
  if (captures.has(pinloomSessionId)) return;
  const db = getDb();
  const cursorRow = db
    .prepare('SELECT last_captured_transcript_uuid AS cursor FROM sessions WHERE id = ?')
    .get(pinloomSessionId) as { cursor: string | null } | undefined;
  const durable = durableRow(pinloomSessionId);
  const state: CaptureState = {
    unregister: () => {},
    legacyCursor: cursorRow?.cursor ?? null,
    durable,
    tail: durable
      ? createClaudeTranscriptTailState(durable.completeOffset, {
          transcriptIdentity: durable.transcriptIdentity,
        })
      : null,
    agentSessionId: resumeSessionId,
    running: false,
    rescanPending: false,
  };
  captures.set(pinloomSessionId, state);

  const server = await getStopHookServer();
  state.unregister = server.onStop(pinloomSessionId, (payload) => {
    void onStop(pinloomSessionId, payload);
  });

  if (resumeSessionId) catchUpFromTranscript(pinloomSessionId, state, resumeSessionId);
}

function catchUpFromTranscript(
  pinloomSessionId: string,
  state: CaptureState,
  resumeSessionId: string,
): void {
  if (state.running) return;
  const row = getDb()
    .prepare(
      `SELECT p.cwd AS cwd
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(pinloomSessionId) as { cwd: string | null } | undefined;
  if (!row?.cwd) return;
  const transcriptPath = sessionFilePath(row.cwd, resumeSessionId);

  state.running = true;
  let result: FoldResult = { persistedAny: false, settled: false };
  try {
    result = foldTranscript(pinloomSessionId, state, transcriptPath);
  } catch (error) {
    console.warn('[claude-pty] catch-up fold failed for %s:', pinloomSessionId, error);
  } finally {
    state.running = false;
  }

  if (result.persistedAny && result.settled) {
    signalTurnComplete(pinloomSessionId);
  } else if (!result.settled && state.durable?.lastConversationType === 'user') {
    startAssistantRescan(pinloomSessionId, transcriptPath);
  }
}

/** Link a Claude session id discovered from the transcript directory. */
export function linkClaudeSessionId(
  pinloomSessionId: string,
  claudeSessionId: string,
): void {
  const state = captures.get(pinloomSessionId);
  if (!state || state.agentSessionId === claudeSessionId) return;
  state.agentSessionId = claudeSessionId;
  getDb()
    .prepare(
      `UPDATE sessions
       SET agent_session_id = ?, claude_session_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(claudeSessionId, claudeSessionId, new Date().toISOString(), pinloomSessionId);
  catchUpFromTranscript(pinloomSessionId, state, claudeSessionId);
}

export function isRescanPending(pinloomSessionId: string): boolean {
  return captures.get(pinloomSessionId)?.rescanPending ?? false;
}

export function stopCapture(pinloomSessionId: string): void {
  const state = captures.get(pinloomSessionId);
  if (!state) return;
  state.unregister();
  captures.delete(pinloomSessionId);
}

function signalTurnComplete(pinloomSessionId: string): void {
  emitRunStatus(pinloomSessionId, 'finished');
  notifySessionIdle(pinloomSessionId);
}

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
  if (!state) return;
  if (state.running) {
    scheduleAssistantRescan(pinloomSessionId, transcriptPath, attempt);
    return;
  }
  state.running = true;
  let settled = false;
  try {
    settled = foldTranscript(pinloomSessionId, state, transcriptPath).settled;
  } catch (error) {
    console.warn('[claude-pty] late assistant re-scan failed for %s:', pinloomSessionId, error);
  } finally {
    state.running = false;
  }
  if (settled) {
    state.rescanPending = false;
    signalTurnComplete(pinloomSessionId);
    return;
  }
  if (attempt + 1 >= RESCAN_MAX_ATTEMPTS) {
    state.rescanPending = false;
    signalTurnComplete(pinloomSessionId);
    return;
  }
  scheduleAssistantRescan(pinloomSessionId, transcriptPath, attempt + 1);
}

async function onStop(pinloomSessionId: string, payload: StopHookPayload): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state || !payload.transcriptPath || state.running) return;
  state.running = true;

  let result: FoldResult = { persistedAny: false, settled: false };
  try {
    if (state.agentSessionId !== payload.sessionId) {
      state.agentSessionId = payload.sessionId;
      getDb()
        .prepare(
          `UPDATE sessions
           SET agent_session_id = ?, claude_session_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          payload.sessionId,
          payload.sessionId,
          new Date().toISOString(),
          pinloomSessionId,
        );
    }

    result = foldTranscript(pinloomSessionId, state, payload.transcriptPath);
    for (let attempt = 0; attempt < FLUSH_POLL_ATTEMPTS && !result.settled; attempt++) {
      await sleep(120);
      const next = foldTranscript(pinloomSessionId, state, payload.transcriptPath);
      result = {
        persistedAny: result.persistedAny || next.persistedAny,
        settled: next.settled,
      };
    }
  } catch (error) {
    console.warn('[claude-pty] transcript capture failed for %s:', pinloomSessionId, error);
  } finally {
    state.running = false;
  }

  if (!result.settled) {
    startAssistantRescan(pinloomSessionId, payload.transcriptPath);
  } else if (result.persistedAny) {
    signalTurnComplete(pinloomSessionId);
  }
}
