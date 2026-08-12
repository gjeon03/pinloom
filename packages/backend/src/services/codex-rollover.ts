import { nanoid } from 'nanoid';
import type { Message, ReasoningEffort, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';
import { isExecRunning } from './exec.js';
import { isAiRunning } from './runner.js';
import {
  isCodexTerminalBusy,
  requestCodexTerminalCheckpoint,
  type CodexDispatchResult,
} from './codex-pty/agent-terminal.js';

export const CODEX_ROLLOVER_PROMPT = `Create a self-contained checkpoint for continuing this exact work in a fresh Codex session.
Keep the checkpoint at or below 12,000 UTF-16 code units. Be concrete and preserve details needed to resume safely.
Respond in concise Markdown and use the five required Markdown section headings exactly as written.

## Current objective and progress

## Decisions and constraints

## Changed files and relevant commands

## Open work and next action

## Failures, gotchas, and verification state`;

export const CHECKPOINT_MIDDLE_OMITTED =
  '\n\n<!-- checkpoint middle omitted by Pinloom -->\n\n';

const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const CHECKPOINT_PRESERVE_LIMIT = 16_000;
const CHECKPOINT_PREFIX_LENGTH = 12_000;
const CHECKPOINT_SUFFIX_LENGTH = 4_000;

type RolloverStatus = 400 | 404 | 409 | 502;

export class CodexRolloverError extends Error {
  constructor(
    readonly status: RolloverStatus,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRolloverError';
  }
}

export interface CodexRolloverDependencies {
  requestCheckpoint?: (
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<CodexDispatchResult>;
}

interface SessionRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  agent: string;
  agent_session_id: string | null;
  claude_session_id: string | null;
  title: string | null;
  next_image_number: number;
  last_synced_message_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  transport: string | null;
  bot_kind: string | null;
  created_at: string;
  updated_at: string;
}

interface PinRow {
  id: string;
  content: string;
  pin_title: string | null;
}

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const rollovers = new Map<string, Promise<Session>>();

function toSession(row: SessionRow): Session {
  const effort = row.reasoning_effort && VALID_EFFORTS.has(row.reasoning_effort)
    ? row.reasoning_effort as ReasoningEffort
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    agentSessionId: row.agent_session_id ?? row.claude_session_id,
    claudeSessionId: row.agent_session_id ?? row.claude_session_id,
    title: row.title,
    nextImageNumber: row.next_image_number,
    lastSyncedMessageId: row.last_synced_message_id,
    model: row.model,
    reasoningEffort: effort,
    transport:
      row.transport === 'sdk' || row.transport === 'pty' || row.transport === 'terminal'
        ? row.transport
        : null,
    botKind:
      row.bot_kind === 'schedule' || row.bot_kind === 'skill'
        ? row.bot_kind
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPinnedMessage(args: {
  id: string;
  sessionId: string;
  content: string;
  title: string | null;
  pinnedAt: string;
  sourceMessageId: string | null;
  createdAt: string;
}): Message {
  return {
    id: args.id,
    sessionId: args.sessionId,
    planItemId: null,
    role: 'assistant',
    content: args.content,
    toolUse: null,
    pinned: true,
    pinTitle: args.title,
    pinnedAt: args.pinnedAt,
    sourceMessageId: args.sourceMessageId,
    model: null,
    createdAt: args.createdAt,
  };
}

function boundCheckpoint(reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed) {
    throw new CodexRolloverError(502, 'checkpoint reply was empty');
  }
  if (trimmed.length <= CHECKPOINT_PRESERVE_LIMIT) return trimmed;
  return `${trimmed.slice(0, CHECKPOINT_PREFIX_LENGTH)}${CHECKPOINT_MIDDLE_OMITTED}${trimmed.slice(-CHECKPOINT_SUFFIX_LENGTH)}`;
}

function assertEligibleSource(
  sessionId: string,
  db: ReturnType<typeof getDb> = getDb(),
): SessionRow {
  const source = db.prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!source) throw new CodexRolloverError(404, 'session not found');
  if (source.agent !== 'codex') {
    throw new CodexRolloverError(400, 'rollover requires a Codex session');
  }
  if (source.transport !== 'terminal') {
    throw new CodexRolloverError(400, 'rollover requires terminal transport');
  }
  if (source.bot_kind !== null) {
    throw new CodexRolloverError(400, 'bot sessions cannot be rolled over');
  }

  const orchestrator = db.prepare(
    'SELECT 1 AS present FROM teams WHERE orchestrator_session_id = ?',
  ).get(sessionId);
  if (orchestrator) {
    throw new CodexRolloverError(400, 'team orchestrators cannot be rolled over');
  }
  const worker = db.prepare(
    'SELECT 1 AS present FROM team_members WHERE session_id = ?',
  ).get(sessionId);
  if (worker) {
    throw new CodexRolloverError(400, 'team workers cannot be rolled over');
  }
  if (isAiRunning(sessionId)) {
    throw new CodexRolloverError(409, 'AI run is active');
  }
  if (isExecRunning(sessionId)) {
    throw new CodexRolloverError(409, 'shell command is active');
  }
  if (isCodexTerminalBusy(sessionId)) {
    throw new CodexRolloverError(409, 'Codex terminal is busy');
  }
  return source;
}

async function performRollover(
  sourceSessionId: string,
  dependencies: CodexRolloverDependencies,
): Promise<Session> {
  assertEligibleSource(sourceSessionId);
  const requestCheckpoint = dependencies.requestCheckpoint ?? requestCodexTerminalCheckpoint;
  const controller = new AbortController();
  let result: CodexDispatchResult;
  try {
    result = await requestCheckpoint(
      sourceSessionId,
      CODEX_ROLLOVER_PROMPT,
      controller.signal,
      CHECKPOINT_TIMEOUT_MS,
    );
  } catch (err) {
    throw new CodexRolloverError(
      502,
      `checkpoint generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!result.ok) {
    const status = result.kind === 'busy' ? 409 : 502;
    throw new CodexRolloverError(status, `checkpoint generation failed: ${result.error}`);
  }
  const checkpointContent = boundCheckpoint(result.reply);

  const db = getDb();
  const destinationId = nanoid();
  const now = new Date().toISOString();

  const committed = db.transaction(() => {
    const source = assertEligibleSource(sourceSessionId, db);
    const pins = db.prepare(
      `SELECT id, content, pin_title
       FROM messages
       WHERE session_id = ? AND pinned = 1
       ORDER BY COALESCE(pinned_at, created_at) ASC, created_at ASC, rowid ASC`,
    ).all(sourceSessionId) as PinRow[];
    const title = source.title ? `${source.title} (continued)` : 'Continued session';
    const order = db.prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS max FROM sessions WHERE project_id = ?',
    ).get(source.project_id) as { max: number };
    db.prepare(
      `INSERT INTO sessions
         (id, project_id, plan_id, agent, claude_session_id, agent_session_id,
          title, order_index, source_session_id, model, reasoning_effort, transport,
          created_at, updated_at)
       VALUES (?, ?, ?, 'codex', NULL, NULL, ?, ?, ?, ?, ?, 'terminal', ?, ?)`,
    ).run(
      destinationId,
      source.project_id,
      source.plan_id,
      title,
      order.max + 1,
      sourceSessionId,
      source.model,
      source.reasoning_effort,
      now,
      now,
    );

    const messages: Message[] = [];
    const insertMessage = db.prepare(
      `INSERT INTO messages
         (id, session_id, plan_item_id, role, content, tool_use, pinned,
          pin_title, pinned_at, source_message_id, model, created_at)
       VALUES (?, ?, NULL, 'assistant', ?, NULL, 1, ?, ?, ?, NULL, ?)`,
    );
    for (const [index, pin] of pins.entries()) {
      const id = nanoid();
      const messageTime = new Date(Date.parse(now) + index).toISOString();
      insertMessage.run(
        id,
        destinationId,
        pin.content,
        pin.pin_title,
        messageTime,
        pin.id,
        messageTime,
      );
      messages.push(toPinnedMessage({
        id,
        sessionId: destinationId,
        content: pin.content,
        title: pin.pin_title,
        pinnedAt: messageTime,
        sourceMessageId: pin.id,
        createdAt: messageTime,
      }));
    }

    const checkpointId = nanoid();
    const checkpointTime = new Date(Date.parse(now) + pins.length).toISOString();
    insertMessage.run(
      checkpointId,
      destinationId,
      checkpointContent,
      'Rollover checkpoint',
      checkpointTime,
      null,
      checkpointTime,
    );
    messages.push(toPinnedMessage({
      id: checkpointId,
      sessionId: destinationId,
      content: checkpointContent,
      title: 'Rollover checkpoint',
      pinnedAt: checkpointTime,
      sourceMessageId: null,
      createdAt: checkpointTime,
    }));

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?')
      .get(destinationId) as SessionRow;
    return { session: toSession(row), messages, projectId: source.project_id };
  })();

  for (const message of committed.messages) {
    try {
      broadcast(`session:${destinationId}`, {
        type: 'message',
        sessionId: destinationId,
        message,
      });
    } catch {
      // The transaction is committed; websocket delivery is best effort.
    }
  }
  try {
    broadcast(`project:${committed.projectId}`, {
      type: 'session_created',
      projectId: committed.projectId,
      session: committed.session,
    });
  } catch {
    // The caller still receives the committed session and must not retry it.
  }
  return committed.session;
}

export function rolloverCodexSession(
  sessionId: string,
  dependencies: CodexRolloverDependencies = {},
): Promise<Session> {
  if (rollovers.has(sessionId)) {
    return Promise.reject(new CodexRolloverError(409, 'rollover already in progress'));
  }
  const operation = performRollover(sessionId, dependencies);
  rollovers.set(sessionId, operation);
  void operation.finally(() => {
    if (rollovers.get(sessionId) === operation) rollovers.delete(sessionId);
  }).catch(() => {});
  return operation;
}
