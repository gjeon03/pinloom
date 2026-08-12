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

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getDb } from '../../db/connection.js';
import { persistMessage, emitRunStatus, notifySessionIdle } from '../runner.js';
import { findRollout } from './rollout.js';
import {
  createRolloutTailState,
  readRolloutDelta,
  scanRolloutPrefix,
  isTaskComplete,
  type RolloutPrefix,
  type RolloutTailState,
} from './rollout-tail.js';
import {
  commitCodexContextSummary,
  getCodexContextObservationCursor,
  isCodexContextPendingSummary,
  mergeCodexContextSummaries,
  summarizeCodexContextObservation,
  type CodexContextPendingSummary,
} from '../codex-context.js';
import {
  parseRolloutRows,
  rolloutSessionId,
  type CodexRolloutLine,
} from '../codex-rollout/parse.js';

/**
 * The persisted capture cursor.
 *
 * `last_captured_transcript_uuid` is documented above as an opaque string, so it
 * carries the byte offset alongside the line index. Holding the offset is what
 * lets a resumed session start reading at its fold boundary instead of parsing
 * the whole rollout to find it — the old rehydrate measured 845ms on a 323MB
 * file, and past V8's string cap it would have failed outright.
 */
interface PersistedCursor {
  /** Lines folded into messages. */
  l: number;
  /** Completed turns folded. */
  t: number;
  /** Byte offset just past line `l`. */
  b: number;
  /** Turn ids folded by stall before their late task_complete arrives. */
  s?: string[];
  /** Rollout generation addressed by `b`. */
  r?: string;
  /** Bounded telemetry reduction waiting for a successful context transaction. */
  p?: CodexContextPendingSummary;
  /** Logical telemetry observation generation. */
  g?: string;
}

interface CursorMigrationPending {
  cursor: PersistedCursor;
  decimal: boolean;
  resumeSessionId: string | null;
}

interface ParsedCursor {
  cursor: PersistedCursor;
  /** A legacy integer was converted and must be written back immediately. */
  migrated: boolean;
  /** Legacy line index awaiting a successful prefix scan. */
  migrationPending: CursorMigrationPending | null;
}

function resolveCursorMigration(
  pending: CursorMigrationPending,
  prefix: RolloutPrefix,
): PersistedCursor {
  const sessionCompatible = pending.resumeSessionId !== null &&
    prefix.sessionId === pending.resumeSessionId;
  const hasGenerationEvidence = pending.cursor.l === 0 || sessionCompatible;
  const compatible = pending.decimal
    ? prefix.lines === pending.cursor.l && hasGenerationEvidence
    : prefix.lines === pending.cursor.l &&
      prefix.turns === pending.cursor.t &&
      prefix.offset === pending.cursor.b &&
      hasGenerationEvidence;
  if (!compatible) {
    return {
      l: 0,
      t: 0,
      b: 0,
      r: prefix.rolloutIdentity,
      g: `rollout:${prefix.rolloutIdentity}`,
    };
  }
  const pendingSummary = pending.cursor.p?.rolloutIdentity === prefix.rolloutIdentity
    ? pending.cursor.p
    : undefined;
  return {
    l: pending.cursor.l,
    t: pending.decimal ? prefix.turns : pending.cursor.t,
    b: pending.decimal ? prefix.offset : pending.cursor.b,
    s: pending.cursor.s,
    r: prefix.rolloutIdentity,
    p: pendingSummary,
    g: pending.cursor.g ?? pendingSummary?.generationId ?? `rollout:${prefix.rolloutIdentity}`,
  };
}

function parseCursor(
  raw: string | null,
  codexHome: string,
  resumeSessionId: string | null,
): ParsedCursor {
  const empty = (): ParsedCursor => ({
    cursor: { l: 0, t: 0, b: 0 },
    migrated: false,
    migrationPending: null,
  });
  if (!raw) return empty();
  if (raw.startsWith('{')) {
    try {
      const c = JSON.parse(raw) as Partial<PersistedCursor>;
      if (
        Number.isSafeInteger(c.l) &&
        Number.isSafeInteger(c.t) &&
        Number.isSafeInteger(c.b) &&
        (c.l as number) >= 0 &&
        (c.t as number) >= 0 &&
        (c.b as number) >= 0 &&
        (c.t as number) <= (c.l as number) &&
        (((c.l as number) === 0 && (c.t as number) === 0 && (c.b as number) === 0) ||
          ((c.l as number) > 0 && (c.b as number) > 0))
      ) {
        const rolloutIdentity =
          typeof c.r === 'string' && c.r.length > 0 ? c.r : undefined;
        const pending = isCodexContextPendingSummary(c.p) &&
          (!rolloutIdentity || c.p.rolloutIdentity === rolloutIdentity)
          ? c.p
          : undefined;
        const normalizedPending = c.p !== undefined && pending === undefined;
        const cursor: PersistedCursor = {
          l: c.l as number,
          t: c.t as number,
          b: c.b as number,
          s: Array.isArray(c.s) ? c.s.filter((id): id is string => typeof id === 'string') : [],
          r: rolloutIdentity,
          p: pending,
          g: pending?.generationId ?? (
            typeof c.g === 'string' && c.g.length > 0 ? c.g : undefined
          ),
        };
        if (cursor.r) {
          return {
            cursor,
            migrated: normalizedPending,
            migrationPending: null,
          };
        }
        const migration: CursorMigrationPending = {
          cursor,
          decimal: false,
          resumeSessionId,
        };
        const path = findRollout(codexHome);
        if (!path) return { ...empty(), migrationPending: migration };
        const prefix = scanRolloutPrefix(path, cursor.l);
        if (!prefix) return { ...empty(), migrationPending: migration };
        return {
          cursor: resolveCursorMigration(migration, prefix),
          migrated: true,
          migrationPending: null,
        };
      }
    } catch {
      // fall through to the legacy reading
    }
  }
  // Legacy cursor: a bare line index with no offset. Recover the offset (and the
  // turn baseline) with one chunked pass, then every later start reads the JSON
  // form and touches nothing.
  if (!/^\d+$/.test(raw)) return empty();
  const lines = Number(raw);
  if (!Number.isSafeInteger(lines) || lines < 0) return empty();
  const migration: CursorMigrationPending = {
    cursor: { l: lines, t: 0, b: 0 },
    decimal: true,
    resumeSessionId,
  };
  const path = findRollout(codexHome);
  if (!path) return { ...empty(), migrationPending: migration };
  const prefix = scanRolloutPrefix(path, lines);
  if (!prefix) return { ...empty(), migrationPending: migration };
  return {
    cursor: resolveCursorMigration(migration, prefix),
    migrated: true,
    migrationPending: null,
  };
}

function serializeCursor(cursor: PersistedCursor): string {
  const serialized: PersistedCursor = { l: cursor.l, t: cursor.t, b: cursor.b };
  if (cursor.s && cursor.s.length > 0) serialized.s = cursor.s;
  if (cursor.r) serialized.r = cursor.r;
  if (cursor.p) serialized.p = cursor.p;
  if (cursor.g) serialized.g = cursor.g;
  return JSON.stringify(serialized satisfies PersistedCursor);
}

const POLL_MS = 500;
// How long the rollout must be QUIET (no new lines) with un-captured content
// and no task_complete before we fold it anyway. codex normally emits
// task_complete at turn end; a turn that never does (Esc-interrupt, crash) would
// otherwise never be captured and would hang any dispatch waiter to timeout.
// Generous so a legitimately slow turn (codex still emits function_call lines as
// it works, which reset the timer) isn't folded mid-flight.
const STALL_MS = 6000;

interface CaptureState {
  codexHome: string;
  rolloutPath: string | null;
  /** Lines folded into messages so far. */
  cursor: number;
  /** Byte offset just past line `cursor` — where a restart resumes reading. */
  cursorOffset: number;
  /** Stateful physical reader; unfinished bytes are never reread on the next poll. */
  tail: RolloutTailState;
  /** Physical rollout size passed to telemetry most recently. */
  lastObservedFileSizeBytes: number | null;
  /** Constant-space reduction retained until its telemetry transaction commits. */
  telemetryPending: CodexContextPendingSummary | null;
  /** Whether `telemetryPending` is present in the durable transcript cursor. */
  telemetryPendingPersisted: boolean;
  /** Last context observation range known committed in SQLite. */
  telemetryBaseIdentity: string | null;
  telemetryBaseOffset: number;
  /** Logical idempotency generation shared by cursor summaries and context state. */
  telemetryGenerationId: string | null;
  /** A failed best-effort cursor clear/reset that should be retried. */
  cursorNeedsWrite: boolean;
  /** Legacy cursor that must scan successfully before any rollout read/fold. */
  migrationPending: CursorMigrationPending | null;
  /** Total parsed lines seen; equals the old whole-file `lines.length`. */
  lineCount: number;
  /** Lines `[cursor, lineCount)` awaiting a fold, with their end offsets. */
  pending: CodexRolloutLine[];
  pendingEnds: number[];
  /** task_complete boundaries consumed into the persisted cursor. */
  turnsSeen: number;
  /** A task started but has not completed or been stalled yet. */
  activeTurnId: string | null;
  /** Stalled turns whose task_complete may still arrive late. */
  stalledTurnIds: Set<string>;
  /** Line count at the last poll + when it last changed — drives stall detection. */
  lastLineCount: number;
  lastGrowthAt: number;
  /** codex session id (resume token) once known. */
  codexSessionId: string | null;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** One-shot waiters for the next completed turn (dispatch). */
  waiters: TurnWaiter[];
  /** Terminal lifecycle hook invoked at every normal or stalled turn boundary. */
  onTurnComplete: (() => void) | null;
}

interface TurnWaiter {
  /** Null until the first task_started observed after waiter registration. */
  turnId: string | null;
  resolve(reply: string): void;
}

const captures = new Map<string, CaptureState>();

/** Begin polling a codex terminal session's rollout. Idempotent. */
export function startCodexCapture(
  pinloomSessionId: string,
  codexHome: string,
  resumeSessionId: string | null,
  onTurnComplete: (() => void) | null = null,
): void {
  if (captures.has(pinloomSessionId)) return;
  const db = getDb();
  const cursorRow = db
    .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id = ?')
    .get(pinloomSessionId) as { c: string | null } | undefined;
  const parsedCursor = parseCursor(cursorRow?.c ?? null, codexHome, resumeSessionId);
  const cursor = parsedCursor.cursor;
  const observationCursor = getCodexContextObservationCursor(pinloomSessionId);
  if (parsedCursor.migrated) {
    db.prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?').run(
      serializeCursor(cursor),
      pinloomSessionId,
    );
  }

  const telemetryGenerationId = cursor.p?.generationId ?? cursor.g ?? (
    observationCursor.rolloutIdentity === cursor.r
      ? observationCursor.generationId
      : null
  ) ?? (cursor.r ? `rollout:${cursor.r}` : null);
  const canReplayObservationGap =
    cursor.r !== undefined &&
    observationCursor.rolloutIdentity === cursor.r &&
    observationCursor.generationId === telemetryGenerationId &&
    observationCursor.completeOffset < cursor.b &&
    cursor.p === undefined;
  const tailStartOffset = canReplayObservationGap
    ? observationCursor.completeOffset
    : cursor.b;
  const telemetryBaseOffset = cursor.p?.startOffset ?? (
    observationCursor.rolloutIdentity === cursor.r &&
    observationCursor.generationId === telemetryGenerationId
      ? observationCursor.completeOffset
      : cursor.b
  );
  const telemetryBaseIdentity = cursor.p?.rolloutIdentity ?? cursor.r ?? null;
  const state: CaptureState = {
    codexHome,
    rolloutPath: null,
    cursor: cursor.l,
    cursorOffset: cursor.b,
    tail: createRolloutTailState(tailStartOffset, { rolloutIdentity: cursor.r ?? null }),
    lastObservedFileSizeBytes: null,
    telemetryPending: cursor.p ?? null,
    telemetryPendingPersisted: cursor.p !== undefined,
    telemetryBaseIdentity,
    telemetryBaseOffset,
    telemetryGenerationId,
    cursorNeedsWrite: false,
    migrationPending: parsedCursor.migrationPending,
    lineCount: cursor.l,
    pending: [],
    pendingEnds: [],
    // On a resumed session the rollout already holds prior turns; baseline
    // turnsSeen (and the total it is compared against) to them so the next
    // completed turn (not a captured one) is what wakes dispatch waiters and
    // gets folded.
    turnsSeen: cursor.t,
    activeTurnId: null,
    stalledTurnIds: new Set(cursor.s ?? []),
    lastLineCount: -1,
    lastGrowthAt: Date.now(),
    codexSessionId: resumeSessionId,
    timer: null,
    running: false,
    waiters: [],
    onTurnComplete,
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
 * Bind to the active or next task_started turn and resolve only for its matching
 * task_complete or stall boundary. Rejects on abort/timeout.
 */
export function awaitCodexTurn(
  pinloomSessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state = captures.get(pinloomSessionId);
    if (!state) return reject(new Error('codex capture not started'));
    if (signal.aborted) return reject(new Error('aborted'));
    let done = false;
    const waiter: TurnWaiter = {
      turnId: state.activeTurnId,
      resolve(reply: string) {
        if (done) return;
        done = true;
        cleanup();
        resolve(reply);
      },
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

/** Run one capture poll without changing the production interval lifecycle. */
export async function pollCodexCaptureOnce(pinloomSessionId: string): Promise<void> {
  await poll(pinloomSessionId);
}

function persistedCursorFromState(state: CaptureState): PersistedCursor {
  return {
    l: state.cursor,
    t: state.turnsSeen,
    b: state.cursorOffset,
    s: [...state.stalledTurnIds],
    r: state.tail.rolloutIdentity ?? undefined,
    p: state.telemetryPending ?? undefined,
    g: state.telemetryGenerationId ?? undefined,
  };
}

function persistCaptureCursor(pinloomSessionId: string, state: CaptureState): boolean {
  try {
    getDb().prepare(
      'UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?',
    ).run(serializeCursor(persistedCursorFromState(state)), pinloomSessionId);
    state.telemetryPendingPersisted = state.telemetryPending !== null;
    state.cursorNeedsWrite = false;
    return true;
  } catch (err) {
    state.cursorNeedsWrite = true;
    console.warn('[codex-pty] cursor persistence failed for %s:', pinloomSessionId, err);
    return false;
  }
}

function retryTelemetryPending(pinloomSessionId: string, state: CaptureState): boolean {
  const pending = state.telemetryPending;
  if (!pending) return true;
  let result: ReturnType<typeof commitCodexContextSummary>;
  try {
    result = commitCodexContextSummary(pinloomSessionId, pending);
  } catch (err) {
    console.warn('[codex-pty] context telemetry failed for %s:', pinloomSessionId, err);
    return false;
  }
  if (!result.committed) return false;
  state.telemetryBaseIdentity = pending.rolloutIdentity;
  state.telemetryBaseOffset = pending.completeOffset;
  state.telemetryGenerationId = pending.generationId;
  state.lastObservedFileSizeBytes = pending.rolloutBytes;
  state.telemetryPending = null;
  if (state.telemetryPendingPersisted) {
    state.cursorNeedsWrite = true;
    persistCaptureCursor(pinloomSessionId, state);
  }
  state.telemetryPendingPersisted = false;
  return true;
}

async function poll(pinloomSessionId: string): Promise<void> {
  const state = captures.get(pinloomSessionId);
  if (!state || state.running) return;
  state.running = true;
  try {
    if (state.cursorNeedsWrite) persistCaptureCursor(pinloomSessionId, state);
    retryTelemetryPending(pinloomSessionId, state);
    // Re-resolve if the cached rollout vanished. Retain generation state until
    // a replacement is opened so its identity can prove whether reset is needed.
    if (state.rolloutPath && !existsSync(state.rolloutPath)) {
      state.rolloutPath = null;
    }
    if (!state.rolloutPath) {
      state.rolloutPath = findRollout(state.codexHome);
      if (!state.rolloutPath) return;
    }
    if (state.migrationPending !== null) {
      const migration = state.migrationPending;
      const prefix = scanRolloutPrefix(state.rolloutPath, migration.cursor.l);
      if (!prefix) return;
      const resolved = resolveCursorMigration(migration, prefix);
      const observationCursor = getCodexContextObservationCursor(pinloomSessionId);
      const generationId = resolved.p?.generationId ?? resolved.g ?? (
        observationCursor.rolloutIdentity === resolved.r
          ? observationCursor.generationId
          : null
      ) ?? (resolved.r ? `rollout:${resolved.r}` : null);
      const canReplayObservationGap =
        resolved.r !== undefined &&
        observationCursor.rolloutIdentity === resolved.r &&
        observationCursor.generationId === generationId &&
        observationCursor.completeOffset < resolved.b &&
        resolved.p === undefined;
      state.cursor = resolved.l;
      state.cursorOffset = resolved.b;
      state.tail = createRolloutTailState(
        canReplayObservationGap ? observationCursor.completeOffset : resolved.b,
        { rolloutIdentity: resolved.r ?? null },
      );
      state.lineCount = resolved.l;
      state.turnsSeen = resolved.t;
      state.stalledTurnIds = new Set(resolved.s ?? []);
      state.telemetryPending = resolved.p ?? null;
      state.telemetryPendingPersisted = resolved.p !== undefined;
      state.telemetryBaseIdentity = resolved.p?.rolloutIdentity ?? resolved.r ?? null;
      state.telemetryBaseOffset = resolved.p?.startOffset ?? (
        observationCursor.rolloutIdentity === resolved.r &&
        observationCursor.generationId === generationId
          ? observationCursor.completeOffset
          : resolved.b
      );
      state.telemetryGenerationId = generationId;
      state.migrationPending = null;
      if (!persistCaptureCursor(pinloomSessionId, state)) return;
    }

    // Read only what codex appended since the last tick. An idle session costs
    // a single stat inside readRolloutDelta and nothing else.
    const delta = readRolloutDelta(state.rolloutPath, state.tail);
    if (delta.truncated) {
      resetCapture(
        state,
        pinloomSessionId,
        delta.rolloutIdentity,
        delta.fileSizeBytes,
      );
      return; // next tick re-reads the replacement from the start
    }
    // Telemetry is strictly incremental: only lines completed in this read are
    // observed, before any turn folding. Its persistence is best effort and
    // must never prevent message capture or dispatch waiter completion.
    const shouldObserveContext = delta.rolloutIdentity !== null && (
      delta.lines.length > 0 ||
      (delta.fileSizeBytes !== null && delta.fileSizeBytes !== state.lastObservedFileSizeBytes)
    );
    if (shouldObserveContext && delta.rolloutIdentity) {
      state.telemetryGenerationId ??= `rollout:${delta.rolloutIdentity}`;
      if (state.telemetryBaseIdentity === null) {
        state.telemetryBaseIdentity = delta.rolloutIdentity;
      } else if (
        state.telemetryBaseIdentity !== delta.rolloutIdentity &&
        state.telemetryPending === null
      ) {
        state.telemetryBaseIdentity = delta.rolloutIdentity;
        state.telemetryBaseOffset = 0;
      }
      const summaryStart = state.telemetryPending?.completeOffset ?? state.telemetryBaseOffset;
      const next = summarizeCodexContextObservation({
        lines: delta.lines,
        lineEnds: delta.lineEnds,
        completeOffset: delta.offset,
        rolloutIdentity: delta.rolloutIdentity,
        rolloutBytes: delta.fileSizeBytes,
      }, summaryStart, false, state.telemetryGenerationId);
      if (next) {
        state.telemetryPending = state.telemetryPending
          ? mergeCodexContextSummaries(state.telemetryPending, next)
          : next;
        if (state.telemetryPending) retryTelemetryPending(pinloomSessionId, state);
      }
    }
    const transcriptLines: CodexRolloutLine[] = [];
    const transcriptEnds: number[] = [];
    for (let index = 0; index < delta.lines.length; index++) {
      if (delta.lineEnds[index] <= state.cursorOffset) continue;
      transcriptLines.push(delta.lines[index]);
      transcriptEnds.push(delta.lineEnds[index]);
    }
    if (transcriptLines.length > 0) {
      state.lineCount += transcriptLines.length;
      state.pending.push(...transcriptLines);
      state.pendingEnds.push(...transcriptEnds);
      // session_meta is the rollout's first line, so claim it as it streams by
      // rather than from a folded slice — a fold that starts past the header
      // would never see it.
      if (!state.codexSessionId) {
        const sid = rolloutSessionId(delta.lines);
        if (sid) {
          state.codexSessionId = sid;
          getDb()
            .prepare(
              'UPDATE sessions SET agent_session_id = ?, claude_session_id = ?, updated_at = ? WHERE id = ?',
            )
            .run(sid, sid, new Date().toISOString(), pinloomSessionId);
        }
      }
    }

    // Track growth so we can tell a still-working turn (file growing) from a
    // stalled one (interrupted/crashed, no task_complete coming).
    if (state.lineCount !== state.lastLineCount) {
      state.lastLineCount = state.lineCount;
      state.lastGrowthAt = Date.now();
    }

    const consumePending = (take: number, stalledTurnId: string | null = null) => {
      const fresh = state.pending.slice(0, take);
      const rows = parseRolloutRows(fresh);
      for (const row of rows) {
        persistMessage({
          sessionId: pinloomSessionId,
          planItemId: null,
          role: row.role,
          content: row.content,
          toolUse: row.toolUse,
        });
      }

      state.cursorOffset = state.pendingEnds[take - 1] ?? state.cursorOffset;
      state.pending.splice(0, take);
      state.pendingEnds.splice(0, take);
      state.cursor += take;
      for (const line of fresh) {
        if (!isTaskComplete(line)) continue;
        state.turnsSeen++;
        const completedId = taskCompleteTurnId(line);
        if (completedId) state.stalledTurnIds.delete(completedId);
      }
      if (stalledTurnId) state.stalledTurnIds.add(stalledTurnId);
      persistCaptureCursor(pinloomSessionId, state);
      return { fresh };
    };

    const emitTurnBoundary = (
      turnId: string | null,
      fresh: CodexRolloutLine[],
      isFallback: boolean,
    ) => {
      state.activeTurnId = null;
      try {
        state.onTurnComplete?.();
      } catch (err) {
        console.warn('[codex-pty] turn completion callback failed for %s:', pinloomSessionId, err);
      }
      emitRunStatus(pinloomSessionId, 'finished');
      notifySessionIdle(pinloomSessionId);

      if (!turnId) return;
      const turnRows = parseRolloutRows(fresh.slice(1));
      const reply = isFallback
        ? [...turnRows].reverse().find((row) => row.role === 'assistant')?.content ?? ''
        : taskCompleteReply(fresh, turnId) ??
          [...turnRows].reverse().find((row) => row.role === 'assistant')?.content ??
          '';
      const matching = state.waiters.filter((waiter) => waiter.turnId === turnId);
      for (const waiter of matching) waiter.resolve(reply);
    };

    while (state.pending.length > 0) {
      const startIndex = firstTaskStartedIndex(state.pending);
      if (startIndex > 0) {
        consumePending(startIndex);
        continue;
      }

      const quiet = Date.now() - state.lastGrowthAt >= STALL_MS;
      if (startIndex === -1) {
        const orphanCompleteIndex = firstTaskCompleteIndex(state.pending);
        if (orphanCompleteIndex !== -1) {
          consumePending(orphanCompleteIndex + 1);
          continue;
        }
        if (quiet) {
          consumePending(state.pending.length);
          continue;
        }
        state.activeTurnId = null;
        break;
      }

      const turnId = taskStartedTurnId(state.pending[0]);
      state.activeTurnId = turnId;
      if (turnId) {
        for (const waiter of state.waiters) {
          if (waiter.turnId === null) waiter.turnId = turnId;
        }
      }
      const nextStartIndex = firstTaskStartedIndex(state.pending, 1);
      const segmentEnd = nextStartIndex === -1 ? state.pending.length : nextStartIndex;
      const matchingCompleteIndex = turnId
        ? matchingTaskCompleteIndex(state.pending, turnId, segmentEnd)
        : -1;
      if (matchingCompleteIndex !== -1) {
        const consumed = consumePending(matchingCompleteIndex + 1);
        emitTurnBoundary(turnId, consumed.fresh, false);
        continue;
      }
      if (quiet) {
        const consumed = consumePending(segmentEnd, turnId);
        emitTurnBoundary(turnId, consumed.fresh, true);
        continue;
      }
      break;
    }
  } catch (err) {
    console.warn('[codex-pty] rollout capture failed for %s:', pinloomSessionId, err);
  } finally {
    state.running = false;
  }
}

function firstTaskCompleteIndex(lines: CodexRolloutLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (isTaskComplete(lines[i])) return i;
  }
  return -1;
}

function firstTaskStartedIndex(lines: CodexRolloutLine[], from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (isTaskStarted(lines[i])) return i;
  }
  return -1;
}

function isTaskStarted(line: CodexRolloutLine): boolean {
  return (
    line.type === 'event_msg' &&
    (line.payload as { type?: string } | undefined)?.type === 'task_started'
  );
}

function taskStartedTurnId(line: CodexRolloutLine): string | null {
  if (!isTaskStarted(line)) return null;
  const turnId = (line.payload as { turn_id?: unknown } | undefined)?.turn_id;
  return typeof turnId === 'string' ? turnId : null;
}

function taskCompleteTurnId(line: CodexRolloutLine | undefined): string | null {
  if (!line || !isTaskComplete(line)) return null;
  const turnId = (line.payload as { turn_id?: unknown } | undefined)?.turn_id;
  return typeof turnId === 'string' ? turnId : null;
}

function matchingTaskCompleteIndex(
  lines: CodexRolloutLine[],
  turnId: string,
  before: number,
): number {
  for (let i = 1; i < before; i++) {
    if (taskCompleteTurnId(lines[i]) === turnId) return i;
  }
  return -1;
}

function taskCompleteReply(lines: CodexRolloutLine[], turnId: string): string | null {
  for (const line of lines) {
    if (taskCompleteTurnId(line) !== turnId) continue;
    const reply = (line.payload as { last_agent_message?: unknown } | undefined)
      ?.last_agent_message;
    return typeof reply === 'string' ? reply : null;
  }
  return null;
}

/**
 * Drop everything derived from the rollout. Used when the file vanishes or is
 * truncated: a line index and a byte offset both address ONE file, so a
 * replacement has to be read from the start.
 */
function resetCapture(
  state: CaptureState,
  pinloomSessionId?: string,
  rolloutIdentity: string | null = null,
  rolloutBytes: number | null = null,
): void {
  const generationId = randomUUID();
  state.cursor = 0;
  state.cursorOffset = 0;
  state.tail = createRolloutTailState(0, { rolloutIdentity });
  state.lastObservedFileSizeBytes = null;
  state.telemetryPending = rolloutIdentity
    ? {
        rolloutIdentity,
        startOffset: 0,
        completeOffset: 0,
        rolloutBytes,
        compactionCount: 0,
        firstToken: null,
        lastToken: null,
        firstTokenAfterLastCompaction: null,
        resetGeneration: true,
        generationId,
      }
    : null;
  state.telemetryPendingPersisted = false;
  state.telemetryBaseIdentity = rolloutIdentity;
  state.telemetryBaseOffset = 0;
  state.telemetryGenerationId = rolloutIdentity ? generationId : null;
  state.cursorNeedsWrite = false;
  state.lineCount = 0;
  state.pending = [];
  state.pendingEnds = [];
  state.turnsSeen = 0;
  state.activeTurnId = null;
  state.stalledTurnIds.clear();
  state.lastLineCount = -1;
  if (pinloomSessionId) persistCaptureCursor(pinloomSessionId, state);
}
