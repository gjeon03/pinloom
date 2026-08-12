import type { CodexContextState } from '@pinloom/shared';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';
import type { CodexRolloutLine } from './codex-rollout/parse.js';

interface ContextRow {
  session_id: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  context_window_tokens: number | null;
  observed_compactions: number;
  post_compaction_input_tokens: number | null;
  rollout_bytes: number | null;
  awaiting_post_compaction: number;
  rollout_identity: string | null;
  observed_complete_offset: number;
  observation_generation: string | null;
  updated_at: string;
}

interface MutableContextRow {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  context_window_tokens: number | null;
  observed_compactions: number;
  post_compaction_input_tokens: number | null;
  rollout_bytes: number | null;
  awaiting_post_compaction: number;
  rollout_identity: string | null;
  observed_complete_offset: number;
  observation_generation: string | null;
}

export interface CodexContextTokenSummary {
  inputTokens: number;
  cachedInputTokens: number;
  contextWindowTokens: number;
}

function emptyState(sessionId: string): CodexContextState {
  return {
    sessionId,
    available: false,
    inputTokens: null,
    cachedInputTokens: null,
    contextWindowTokens: null,
    observedCompactions: 0,
    postCompactionInputTokens: null,
    rolloutBytes: null,
    updatedAt: null,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function rowToState(row: ContextRow): CodexContextState {
  return {
    sessionId: row.session_id,
    available: isPositiveInteger(row.input_tokens) && isPositiveInteger(row.context_window_tokens),
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    contextWindowTokens: row.context_window_tokens,
    observedCompactions: row.observed_compactions,
    postCompactionInputTokens: row.post_compaction_input_tokens,
    rolloutBytes: row.rollout_bytes,
    updatedAt: row.updated_at,
  };
}

function toMutable(row: ContextRow | null): MutableContextRow {
  if (!row) {
    return {
      input_tokens: null,
      cached_input_tokens: null,
      context_window_tokens: null,
      observed_compactions: 0,
      post_compaction_input_tokens: null,
      rollout_bytes: null,
      awaiting_post_compaction: 0,
      rollout_identity: null,
      observed_complete_offset: 0,
      observation_generation: null,
    };
  }
  return {
    input_tokens: row.input_tokens,
    cached_input_tokens: row.cached_input_tokens,
    context_window_tokens: row.context_window_tokens,
    observed_compactions: row.observed_compactions,
    post_compaction_input_tokens: row.post_compaction_input_tokens,
    rollout_bytes: row.rollout_bytes,
    awaiting_post_compaction: row.awaiting_post_compaction,
    rollout_identity: row.rollout_identity,
    observed_complete_offset: row.observed_complete_offset,
    observation_generation: row.observation_generation,
  };
}

function tokenSample(line: CodexRolloutLine): CodexContextTokenSummary | null {
  if (line.type !== 'event_msg' || line.payload?.type !== 'token_count') return null;
  const info = line.payload.info;
  if (!info || typeof info !== 'object') return null;
  const usage = (info as { last_token_usage?: unknown }).last_token_usage;
  const contextWindow = (info as { model_context_window?: unknown }).model_context_window;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = (usage as { input_tokens?: unknown }).input_tokens;
  const cachedInputTokens = (usage as { cached_input_tokens?: unknown }).cached_input_tokens;
  if (
    !isPositiveInteger(inputTokens) ||
    !isNonNegativeInteger(cachedInputTokens) ||
    !isPositiveInteger(contextWindow)
  ) return null;
  return { inputTokens, cachedInputTokens, contextWindowTokens: contextWindow };
}

function isCanonicalCompaction(line: CodexRolloutLine): boolean {
  return line.type === 'event_msg' && line.payload?.type === 'context_compacted';
}

function differs(left: MutableContextRow, right: ContextRow | null): boolean {
  if (!right) return true;
  return (
    left.input_tokens !== right.input_tokens ||
    left.cached_input_tokens !== right.cached_input_tokens ||
    left.context_window_tokens !== right.context_window_tokens ||
    left.observed_compactions !== right.observed_compactions ||
    left.post_compaction_input_tokens !== right.post_compaction_input_tokens ||
    left.rollout_bytes !== right.rollout_bytes ||
    left.awaiting_post_compaction !== right.awaiting_post_compaction ||
    left.rollout_identity !== right.rollout_identity ||
    left.observed_complete_offset !== right.observed_complete_offset ||
    left.observation_generation !== right.observation_generation
  );
}

function externallyEqual(left: CodexContextState, right: CodexContextState): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.available === right.available &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.contextWindowTokens === right.contextWindowTokens &&
    left.observedCompactions === right.observedCompactions &&
    left.postCompactionInputTokens === right.postCompactionInputTokens &&
    left.rolloutBytes === right.rolloutBytes
  );
}

export function getCodexContextState(sessionId: string): CodexContextState {
  try {
    const row = getDb()
      .prepare('SELECT * FROM codex_context_state WHERE session_id = ?')
      .get(sessionId) as ContextRow | undefined;
    return row ? rowToState(row) : emptyState(sessionId);
  } catch {
    return emptyState(sessionId);
  }
}

export interface CodexContextObservation {
  lines: CodexRolloutLine[];
  lineEnds: number[];
  completeOffset: number;
  rolloutIdentity: string;
  rolloutBytes: number | null;
}

export interface CodexContextObservationResult {
  committed: boolean;
  state: CodexContextState | null;
}

export interface CodexContextPendingSummary {
  rolloutIdentity: string;
  startOffset: number;
  completeOffset: number;
  rolloutBytes: number | null;
  compactionCount: number;
  firstToken: CodexContextTokenSummary | null;
  lastToken: CodexContextTokenSummary | null;
  firstTokenAfterLastCompaction: CodexContextTokenSummary | null;
  resetGeneration: boolean;
  generationId: string;
}

interface PersistenceResult {
  state: CodexContextState | null;
  broadcastState: CodexContextState | null;
}

function hasExactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validTokenSummary(token: unknown): token is CodexContextTokenSummary | null {
  if (token === null) return true;
  if (!token || typeof token !== 'object') return false;
  if (!hasExactKeys(token, ['inputTokens', 'cachedInputTokens', 'contextWindowTokens'])) {
    return false;
  }
  const sample = token as CodexContextTokenSummary;
  return (
    isPositiveInteger(sample.inputTokens) &&
    isNonNegativeInteger(sample.cachedInputTokens) &&
    isPositiveInteger(sample.contextWindowTokens)
  );
}

export function isCodexContextPendingSummary(
  value: unknown,
): value is CodexContextPendingSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<CodexContextPendingSummary>;
  if (!hasExactKeys(value, [
    'rolloutIdentity',
    'startOffset',
    'completeOffset',
    'rolloutBytes',
    'compactionCount',
    'firstToken',
    'lastToken',
    'firstTokenAfterLastCompaction',
    'resetGeneration',
    'generationId',
  ])) return false;
  return (
    typeof summary.rolloutIdentity === 'string' &&
    summary.rolloutIdentity.length > 0 &&
    Number.isSafeInteger(summary.startOffset) &&
    (summary.startOffset as number) >= 0 &&
    Number.isSafeInteger(summary.completeOffset) &&
    (summary.completeOffset as number) >= (summary.startOffset as number) &&
    (
      summary.rolloutBytes === null ||
      (
        Number.isSafeInteger(summary.rolloutBytes) &&
        (summary.rolloutBytes as number) >= 0
      )
    ) &&
    Number.isSafeInteger(summary.compactionCount) &&
    (summary.compactionCount as number) >= 0 &&
    typeof summary.resetGeneration === 'boolean' &&
    typeof summary.generationId === 'string' &&
    summary.generationId.length > 0 &&
    validTokenSummary(summary.firstToken) &&
    validTokenSummary(summary.lastToken) &&
    validTokenSummary(summary.firstTokenAfterLastCompaction) &&
    (summary.compactionCount !== 0 || summary.firstTokenAfterLastCompaction === null)
  );
}

export function summarizeCodexContextObservation(
  observation: CodexContextObservation,
  startOffset: number,
  resetGeneration = false,
  generationId = `rollout:${observation.rolloutIdentity}`,
): CodexContextPendingSummary | null {
  if (
    !validObservation(observation) ||
    !Number.isSafeInteger(startOffset) ||
    startOffset < 0 ||
    observation.completeOffset < startOffset
  ) {
    return null;
  }
  let compactionCount = 0;
  let firstToken: CodexContextTokenSummary | null = null;
  let lastToken: CodexContextTokenSummary | null = null;
  let firstTokenAfterLastCompaction: CodexContextTokenSummary | null = null;
  for (let index = 0; index < observation.lines.length; index++) {
    if (observation.lineEnds[index] <= startOffset) continue;
    const line = observation.lines[index];
    if (isCanonicalCompaction(line)) {
      compactionCount++;
      firstTokenAfterLastCompaction = null;
      continue;
    }
    const token = tokenSample(line);
    if (!token) continue;
    firstToken ??= token;
    lastToken = token;
    if (compactionCount > 0 && firstTokenAfterLastCompaction === null) {
      firstTokenAfterLastCompaction = token;
    }
  }
  return {
    rolloutIdentity: observation.rolloutIdentity,
    startOffset,
    completeOffset: observation.completeOffset,
    rolloutBytes: observation.rolloutBytes,
    compactionCount,
    firstToken,
    lastToken,
    firstTokenAfterLastCompaction,
    resetGeneration,
    generationId,
  };
}

export function mergeCodexContextSummaries(
  left: CodexContextPendingSummary,
  right: CodexContextPendingSummary,
): CodexContextPendingSummary | null {
  if (
    !isCodexContextPendingSummary(left) ||
    !isCodexContextPendingSummary(right) ||
    left.rolloutIdentity !== right.rolloutIdentity ||
    left.completeOffset !== right.startOffset ||
    left.generationId !== right.generationId
  ) {
    return null;
  }
  const compactionCount = left.compactionCount + right.compactionCount;
  if (!Number.isSafeInteger(compactionCount)) return null;
  const firstTokenAfterLastCompaction = right.compactionCount > 0
    ? right.firstTokenAfterLastCompaction
    : left.compactionCount > 0
      ? left.firstTokenAfterLastCompaction ?? right.firstToken
      : null;
  return {
    rolloutIdentity: left.rolloutIdentity,
    startOffset: left.startOffset,
    completeOffset: right.completeOffset,
    rolloutBytes: right.rolloutBytes,
    compactionCount,
    firstToken: left.firstToken ?? right.firstToken,
    lastToken: right.lastToken ?? left.lastToken,
    firstTokenAfterLastCompaction,
    resetGeneration: left.resetGeneration || right.resetGeneration,
    generationId: left.generationId,
  };
}

function validObservation(observation: CodexContextObservation): boolean {
  if (
    observation.lines.length !== observation.lineEnds.length ||
    observation.rolloutIdentity.length === 0 ||
    !Number.isSafeInteger(observation.completeOffset) ||
    observation.completeOffset < 0 ||
    (
      observation.rolloutBytes !== null &&
      (!Number.isSafeInteger(observation.rolloutBytes) || observation.rolloutBytes < 0)
    )
  ) {
    return false;
  }
  let previousEnd = -1;
  for (const end of observation.lineEnds) {
    if (
      !Number.isSafeInteger(end) ||
      end < 0 ||
      end <= previousEnd ||
      end > observation.completeOffset
    ) {
      return false;
    }
    previousEnd = end;
  }
  return true;
}

function applyTokenSummary(
  current: MutableContextRow,
  token: CodexContextTokenSummary,
): void {
  current.input_tokens = token.inputTokens;
  current.cached_input_tokens = token.cachedInputTokens;
  current.context_window_tokens = token.contextWindowTokens;
}

function applyPendingSummary(
  current: MutableContextRow,
  summary: CodexContextPendingSummary,
): boolean {
  const recognized = summary.compactionCount > 0 || summary.lastToken !== null;
  if (summary.compactionCount > 0) {
    current.observed_compactions += summary.compactionCount;
    current.post_compaction_input_tokens =
      summary.firstTokenAfterLastCompaction?.inputTokens ?? null;
    current.awaiting_post_compaction =
      summary.firstTokenAfterLastCompaction === null ? 1 : 0;
  } else if (current.awaiting_post_compaction === 1 && summary.firstToken) {
    current.post_compaction_input_tokens = summary.firstToken.inputTokens;
    current.awaiting_post_compaction = 0;
  }
  if (summary.lastToken) applyTokenSummary(current, summary.lastToken);
  return recognized;
}

function saveContextRow(
  sessionId: string,
  current: MutableContextRow,
  previousRow: ContextRow | undefined,
): PersistenceResult {
  const updatedAt = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO codex_context_state (
      session_id, input_tokens, cached_input_tokens, context_window_tokens,
      observed_compactions, post_compaction_input_tokens, rollout_bytes,
      awaiting_post_compaction, rollout_identity, observed_complete_offset,
      observation_generation, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      context_window_tokens = excluded.context_window_tokens,
      observed_compactions = excluded.observed_compactions,
      post_compaction_input_tokens = excluded.post_compaction_input_tokens,
      rollout_bytes = excluded.rollout_bytes,
      awaiting_post_compaction = excluded.awaiting_post_compaction,
      rollout_identity = excluded.rollout_identity,
      observed_complete_offset = excluded.observed_complete_offset,
      observation_generation = excluded.observation_generation,
      updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    current.input_tokens,
    current.cached_input_tokens,
    current.context_window_tokens,
    current.observed_compactions,
    current.post_compaction_input_tokens,
    current.rollout_bytes,
    current.awaiting_post_compaction,
    current.rollout_identity,
    current.observed_complete_offset,
    current.observation_generation,
    updatedAt,
  );

  const next = rowToState({ session_id: sessionId, ...current, updated_at: updatedAt });
  const previous = previousRow ? rowToState(previousRow) : emptyState(sessionId);
  return {
    state: next,
    broadcastState: externallyEqual(previous, next) ? null : next,
  };
}

function broadcastPersistence(sessionId: string, result: PersistenceResult): void {
  if (!result.broadcastState) return;
  try {
    broadcast(`session:${sessionId}`, {
      type: 'codex_context_updated',
      sessionId,
      context: result.broadcastState,
    });
  } catch {
    // The durable transaction already committed; UI hydration can recover it.
  }
}

function persistObservation(
  sessionId: string,
  lines: CodexRolloutLine[],
  rolloutBytes: number | null,
  observation: CodexContextObservation | null,
): CodexContextObservationResult {
  if (observation && !validObservation(observation)) {
    return { committed: false, state: null };
  }
  try {
    const db = getDb();
    const transaction = db.transaction((): PersistenceResult => {
      const previousRow = db
        .prepare('SELECT * FROM codex_context_state WHERE session_id = ?')
        .get(sessionId) as ContextRow | undefined;
      const current = toMutable(previousRow ?? null);
      let applicableLines = lines;
      if (observation) {
        const sameGeneration =
          previousRow?.rollout_identity === observation.rolloutIdentity &&
          observation.completeOffset >= (previousRow?.observed_complete_offset ?? 0);
        const observedOffset = sameGeneration
          ? previousRow?.observed_complete_offset ?? 0
          : 0;
        applicableLines = observation.lines.filter(
          (_line, index) => observation.lineEnds[index] > observedOffset,
        );
        current.rollout_identity = observation.rolloutIdentity;
        current.observed_complete_offset = observation.completeOffset;
        current.observation_generation = sameGeneration
          ? previousRow?.observation_generation ?? `rollout:${observation.rolloutIdentity}`
          : previousRow?.rollout_identity === observation.rolloutIdentity
            ? randomUUID()
            : `rollout:${observation.rolloutIdentity}`;
      }
      let recognized = false;

      for (const line of applicableLines) {
        if (isCanonicalCompaction(line)) {
          current.observed_compactions += 1;
          current.post_compaction_input_tokens = null;
          current.awaiting_post_compaction = 1;
          recognized = true;
          continue;
        }
        const sample = tokenSample(line);
        if (!sample) continue;
        current.input_tokens = sample.inputTokens;
        current.cached_input_tokens = sample.cachedInputTokens;
        current.context_window_tokens = sample.contextWindowTokens;
        if (current.awaiting_post_compaction === 1) {
          current.post_compaction_input_tokens = sample.inputTokens;
          current.awaiting_post_compaction = 0;
        }
        recognized = true;
      }

      const hasChangedRolloutBytes =
        isNonNegativeInteger(rolloutBytes) && rolloutBytes !== current.rollout_bytes;
      if (!recognized && !previousRow) {
        return { state: null, broadcastState: null };
      }
      if (isNonNegativeInteger(rolloutBytes) && (recognized || previousRow)) {
        current.rollout_bytes = rolloutBytes;
      }
      if (!recognized && !hasChangedRolloutBytes && !differs(current, previousRow ?? null)) {
        return { state: null, broadcastState: null };
      }
      if (!differs(current, previousRow ?? null)) {
        return { state: null, broadcastState: null };
      }

      return saveContextRow(sessionId, current, previousRow);
    });
    const result = transaction();
    broadcastPersistence(sessionId, result);
    return { committed: true, state: result.state };
  } catch {
    return { committed: false, state: null };
  }
}

export function commitCodexContextObservation(
  sessionId: string,
  observation: CodexContextObservation,
): CodexContextObservationResult {
  return persistObservation(
    sessionId,
    observation.lines,
    observation.rolloutBytes,
    observation,
  );
}

export interface CodexContextObservationCursor {
  rolloutIdentity: string | null;
  completeOffset: number;
  generationId: string | null;
}

export function getCodexContextObservationCursor(
  sessionId: string,
): CodexContextObservationCursor {
  try {
    const row = getDb().prepare(
      `SELECT rollout_identity AS rolloutIdentity,
              observed_complete_offset AS completeOffset,
              observation_generation AS generationId
       FROM codex_context_state WHERE session_id = ?`,
    ).get(sessionId) as CodexContextObservationCursor | undefined;
    return row ?? { rolloutIdentity: null, completeOffset: 0, generationId: null };
  } catch {
    return { rolloutIdentity: null, completeOffset: 0, generationId: null };
  }
}

export function commitCodexContextSummary(
  sessionId: string,
  summary: CodexContextPendingSummary,
): CodexContextObservationResult {
  if (!isCodexContextPendingSummary(summary)) {
    return { committed: false, state: null };
  }
  try {
    const db = getDb();
    let rangeConflict = false;
    const transaction = db.transaction((): PersistenceResult => {
      const previousRow = db
        .prepare('SELECT * FROM codex_context_state WHERE session_id = ?')
        .get(sessionId) as ContextRow | undefined;
      if (
        previousRow?.observation_generation === summary.generationId &&
        previousRow.observed_complete_offset >= summary.completeOffset
      ) {
        if (
          previousRow.observed_complete_offset === summary.completeOffset &&
          summary.startOffset === summary.completeOffset &&
          isNonNegativeInteger(summary.rolloutBytes) &&
          summary.rolloutBytes !== previousRow.rollout_bytes
        ) {
          const current = toMutable(previousRow);
          current.rollout_bytes = summary.rolloutBytes;
          return saveContextRow(sessionId, current, previousRow);
        }
        return { state: null, broadcastState: null };
      }
      if (
        previousRow?.observation_generation === summary.generationId &&
        previousRow.observed_complete_offset !== summary.startOffset
      ) {
        rangeConflict = true;
        return { state: null, broadcastState: null };
      }

      const current = toMutable(previousRow ?? null);
      const recognized = applyPendingSummary(current, summary);
      if (!recognized && !previousRow) {
        return { state: null, broadcastState: null };
      }
      current.rollout_identity = summary.rolloutIdentity;
      current.observed_complete_offset = summary.completeOffset;
      current.observation_generation = summary.generationId;
      if (isNonNegativeInteger(summary.rolloutBytes)) {
        current.rollout_bytes = summary.rolloutBytes;
      }
      if (!differs(current, previousRow ?? null)) {
        return { state: null, broadcastState: null };
      }
      return saveContextRow(sessionId, current, previousRow);
    });
    const result = transaction();
    if (rangeConflict) return { committed: false, state: null };
    broadcastPersistence(sessionId, result);
    return { committed: true, state: result.state };
  } catch {
    return { committed: false, state: null };
  }
}

export function observeCodexContext(
  sessionId: string,
  lines: CodexRolloutLine[],
  rolloutBytes: number | null,
): CodexContextState | null {
  return persistObservation(sessionId, lines, rolloutBytes, null).state;
}
