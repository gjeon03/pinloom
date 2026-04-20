import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Message, MessageRole, Session } from '@planloom/shared';
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

interface MessageRow {
  id: string;
  session_id: string;
  plan_item_id: string | null;
  role: string;
  content: string;
  tool_use: string | null;
  created_at: string;
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

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    planItemId: row.plan_item_id,
    role: row.role as MessageRole,
    content: row.content,
    toolUse: row.tool_use,
    createdAt: row.created_at,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/sessions',
    async (req) => {
      const rows = db
        .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
        .all(req.params.projectId) as SessionRow[];
      return rows.map(toSession);
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: { planId?: string | null; title?: string | null };
  }>('/api/projects/:projectId/sessions', async (req) => {
    const id = nanoid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions
         (id, project_id, plan_id, claude_session_id, title, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).run(id, req.params.projectId, req.body.planId ?? null, req.body.title ?? null, now, now);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
    return toSession(row);
  });

  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/messages',
    async (req) => {
      const rows = db
        .prepare(
          'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(req.params.sessionId) as MessageRow[];
      return rows.map(toMessage);
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId',
    async (req) => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.sessionId);
      return { ok: true };
    },
  );
}
