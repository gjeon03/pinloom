import { nanoid } from 'nanoid';
import type { Message, ReasoningEffort, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';

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

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

interface MessageRow {
  id: string;
  session_id: string;
  plan_item_id: string | null;
  role: string;
  content: string;
  tool_use: string | null;
  pinned: number;
  pin_title: string | null;
  pinned_at: string | null;
  source_message_id: string | null;
  model: string | null;
  created_at: string;
}

function toSession(row: SessionRow): Session {
  const agent = row.agent === 'codex' ? 'codex' : 'claude';
  const agentSessionId = row.agent_session_id ?? row.claude_session_id;
  const effort: ReasoningEffort | null =
    row.reasoning_effort && VALID_EFFORTS.has(row.reasoning_effort)
      ? (row.reasoning_effort as ReasoningEffort)
      : null;
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    agent,
    agentSessionId,
    claudeSessionId: agentSessionId,
    title: row.title,
    nextImageNumber: row.next_image_number,
    lastSyncedMessageId: row.last_synced_message_id,
    model: row.model,
    reasoningEffort: effort,
    transport:
      row.transport === 'pty' || row.transport === 'terminal' || row.transport === 'sdk'
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

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    planItemId: row.plan_item_id,
    role: row.role as Message['role'],
    content: row.content,
    toolUse: row.tool_use,
    pinned: row.pinned === 1,
    pinTitle: row.pin_title,
    pinnedAt: row.pinned_at,
    sourceMessageId: row.source_message_id,
    model: row.model,
    createdAt: row.created_at,
  };
}

interface PinSource {
  id: string;
  pin_title: string | null;
  content: string;
}

function copyPinToSession(
  db: ReturnType<typeof getDb>,
  pin: PinSource,
  targetSessionId: string,
  createdAt: string,
): Message {
  const newId = nanoid();
  db.prepare(
    `INSERT INTO messages
       (id, session_id, plan_item_id, role, content, tool_use, pinned, pin_title, pinned_at, source_message_id, created_at)
     VALUES (?, ?, NULL, 'assistant', ?, NULL, 1, ?, ?, ?, ?)`,
  ).run(newId, targetSessionId, pin.content, pin.pin_title, createdAt, pin.id, createdAt);

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(newId) as MessageRow;
  return toMessage(row);
}

export function handoffFromSession(sourceSessionId: string): Session {
  const db = getDb();

  const source = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sourceSessionId) as SessionRow | undefined;
  if (!source) throw new Error(`session ${sourceSessionId} not found`);

  const pins = db
    .prepare(
      `SELECT id, pin_title, content
       FROM messages
       WHERE session_id = ? AND pinned = 1
       ORDER BY created_at ASC`,
    )
    .all(sourceSessionId) as PinSource[];

  if (pins.length === 0) {
    throw new Error('source session has no pins to hand off');
  }

  const newId = nanoid();
  const now = new Date().toISOString();
  const title = source.title ? `${source.title} (handoff)` : 'Handoff';

  const maxOrder = db
    .prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS max FROM sessions WHERE project_id = ?',
    )
    .get(source.project_id) as { max: number };
  const nextOrder = maxOrder.max + 1;

  // Inherit the source session's agent — handoffs continue the same kind
  // of conversation, just with fresh context.
  const sourceAgent = (source as SessionRow).agent === 'codex' ? 'codex' : 'claude';
  db.prepare(
    `INSERT INTO sessions
       (id, project_id, plan_id, agent, claude_session_id, agent_session_id,
        title, order_index, source_session_id, transport, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId,
    source.project_id,
    source.plan_id,
    sourceAgent,
    title,
    nextOrder,
    sourceSessionId,
    // Inherit the source session's transport so a handed-off session opens the
    // same way (terminal stays terminal); null source → sdk.
    (source as SessionRow).transport,
    now,
    now,
  );

  for (const pin of pins) {
    const copied = copyPinToSession(db, pin, newId, now);
    broadcast(`session:${newId}`, {
      type: 'message',
      sessionId: newId,
      message: copied,
    });
  }

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId) as SessionRow;
  return toSession(row);
}

export function injectPinIntoSession(
  targetSessionId: string,
  pinMessageId: string,
): Message {
  const db = getDb();

  const target = db
    .prepare('SELECT id, project_id FROM sessions WHERE id = ?')
    .get(targetSessionId) as { id: string; project_id: string } | undefined;
  if (!target) throw new Error(`target session ${targetSessionId} not found`);

  const pin = db
    .prepare(
      `SELECT m.id, m.pin_title, m.content, m.pinned, s.project_id as src_project
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
    )
    .get(pinMessageId) as
    | {
        id: string;
        pin_title: string | null;
        content: string;
        pinned: number;
        src_project: string;
      }
    | undefined;
  if (!pin) throw new Error(`pin ${pinMessageId} not found`);
  if (pin.pinned !== 1) throw new Error('message is not pinned');
  // Cross-project injection is intentionally allowed — the picker UI
  // exposes sessions across every project so the user can bridge
  // context between related projects (frontend ↔ backend etc). The
  // copy still records source via source_message_id on the new row.

  const now = new Date().toISOString();
  const copied = copyPinToSession(
    db,
    { id: pin.id, pin_title: pin.pin_title, content: pin.content },
    targetSessionId,
    now,
  );
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, targetSessionId);

  broadcast(`session:${targetSessionId}`, {
    type: 'message',
    sessionId: targetSessionId,
    message: copied,
  });

  return copied;
}
