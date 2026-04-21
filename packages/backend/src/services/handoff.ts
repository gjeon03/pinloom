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
