import { nanoid } from 'nanoid';
import type { Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface SessionRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  claude_session_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    claudeSessionId: row.claude_session_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PinRow {
  id: string;
  pin_title: string | null;
  content: string;
  created_at: string;
}

export function buildSeedContext(pins: PinRow[]): string {
  if (pins.length === 0) return '';
  const blocks = pins.map((p) => {
    const heading = p.pin_title?.trim() || '(untitled pin)';
    return `### ${heading}\n\n${p.content.trim()}`;
  });
  return [
    'You are continuing work from a previous session. The user carried forward these pinned notes.',
    'Treat them as authoritative context you already agreed on with the user.',
    '',
    '## Carried-forward pins',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function handoffFromSession(sourceSessionId: string): Session {
  const db = getDb();

  const source = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sourceSessionId) as SessionRow | undefined;
  if (!source) throw new Error(`session ${sourceSessionId} not found`);

  const pins = db
    .prepare(
      `SELECT id, pin_title, content, created_at
       FROM messages
       WHERE session_id = ? AND pinned = 1
       ORDER BY created_at ASC`,
    )
    .all(sourceSessionId) as PinRow[];

  if (pins.length === 0) {
    throw new Error('source session has no pins to hand off');
  }

  const newId = nanoid();
  const now = new Date().toISOString();
  const seedContext = buildSeedContext(pins);
  const title = source.title ? `${source.title} (handoff)` : 'Handoff';

  db.prepare(
    `INSERT INTO sessions
       (id, project_id, plan_id, claude_session_id, title, seed_context, source_session_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    newId,
    source.project_id,
    source.plan_id,
    title,
    seedContext,
    sourceSessionId,
    now,
    now,
  );

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId) as SessionRow;
  return toSession(row);
}

export function consumeSeedContext(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT seed_context FROM sessions WHERE id = ?')
    .get(sessionId) as { seed_context: string | null } | undefined;
  if (!row?.seed_context) return null;

  db.prepare('UPDATE sessions SET seed_context = NULL WHERE id = ?').run(sessionId);
  return row.seed_context;
}

interface PinSourceRow {
  id: string;
  session_id: string;
  pin_title: string | null;
  content: string;
  pinned: number;
}

interface TargetSessionRow {
  id: string;
  project_id: string;
  seed_context: string | null;
}

export function injectPinIntoSession(
  targetSessionId: string,
  pinMessageId: string,
): { sessionId: string; queuedLength: number } {
  const db = getDb();

  const target = db
    .prepare('SELECT id, project_id, seed_context FROM sessions WHERE id = ?')
    .get(targetSessionId) as TargetSessionRow | undefined;
  if (!target) throw new Error(`target session ${targetSessionId} not found`);

  const pin = db
    .prepare(
      `SELECT m.id, m.session_id, m.pin_title, m.content, m.pinned, s.project_id as src_project
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
    )
    .get(pinMessageId) as (PinSourceRow & { src_project: string }) | undefined;
  if (!pin) throw new Error(`pin ${pinMessageId} not found`);
  if (pin.pinned !== 1) throw new Error('message is not pinned');
  if (pin.src_project !== target.project_id) {
    throw new Error('pin and target session are in different projects');
  }

  const heading = pin.pin_title?.trim() || '(untitled pin)';
  const appended =
    `### ${heading}\n\n${pin.content.trim()}\n`;

  const prefix =
    target.seed_context && target.seed_context.length > 0
      ? target.seed_context
      : [
          'You are receiving pinned notes the user attached to this session.',
          'Treat each as authoritative context you already agreed on.',
          '',
          '## Attached pins',
          '',
        ].join('\n');

  const nextContext = `${prefix}\n${appended}`;

  db.prepare('UPDATE sessions SET seed_context = ?, updated_at = ? WHERE id = ?').run(
    nextContext,
    new Date().toISOString(),
    targetSessionId,
  );

  return { sessionId: targetSessionId, queuedLength: nextContext.length };
}
