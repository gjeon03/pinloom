import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Message, MessageRole, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { cancelAiRun, isAiRunning, sendUserMessage } from '../services/runner.js';
import { cancelExecRun, execShellCommand, isExecRunning } from '../services/exec.js';
import { handoffFromSession, injectPinIntoSession } from '../services/handoff.js';

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
  pinned: number;
  pin_title: string | null;
  source_message_id: string | null;
  created_at: string;
}

export function toSession(row: SessionRow): Session {
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

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    planItemId: row.plan_item_id,
    role: row.role as MessageRole,
    content: row.content,
    toolUse: row.tool_use,
    pinned: row.pinned === 1,
    pinTitle: row.pin_title,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  };
}

export function summarizeForPin(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'Pinned';
  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  const stripped = firstLine.replace(/^#+\s*/, '').trim();
  return stripped.length > 80 ? `${stripped.slice(0, 77)}…` : stripped;
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
          `SELECT * FROM messages
           WHERE session_id = ? AND source_message_id IS NULL
           ORDER BY created_at ASC`,
        )
        .all(req.params.sessionId) as MessageRow[];
      return rows.map(toMessage);
    },
  );

  app.post<{
    Params: { sessionId: string };
    Body: { content: string; planItemId?: string | null };
  }>('/api/sessions/:sessionId/messages', async (req, reply) => {
    const { content, planItemId = null } = req.body;
    if (!content || content.trim().length === 0) {
      reply.code(400);
      return { error: 'content is required' };
    }
    try {
      const msg = await sendUserMessage(req.params.sessionId, content, planItemId);
      return msg;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post<{
    Params: { sessionId: string };
    Body: { pinMessageId: string };
  }>('/api/sessions/:sessionId/inject-pin', async (req, reply) => {
    const { pinMessageId } = req.body;
    if (!pinMessageId) {
      reply.code(400);
      return { error: 'pinMessageId is required' };
    }
    try {
      const message = injectPinIntoSession(req.params.sessionId, pinMessageId);
      return { sessionId: req.params.sessionId, message };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/cancel',
    async (req) => {
      const ai = cancelAiRun(req.params.sessionId);
      const exec = cancelExecRun(req.params.sessionId);
      return { cancelled: ai || exec, ai, exec };
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/run-status',
    async (req) => {
      const ai = isAiRunning(req.params.sessionId);
      const exec = isExecRunning(req.params.sessionId);
      return { running: ai || exec, ai, exec };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/handoff',
    async (req, reply) => {
      try {
        const newSession = handoffFromSession(req.params.sessionId);
        return newSession;
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{
    Params: { sessionId: string };
    Body: { command: string };
  }>('/api/sessions/:sessionId/exec', async (req, reply) => {
    const { command } = req.body;
    if (!command || command.trim().length === 0) {
      reply.code(400);
      return { error: 'command is required' };
    }
    try {
      const result = await execShellCommand(req.params.sessionId, command);
      return result;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId',
    async (req) => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.sessionId);
      return { ok: true };
    },
  );

  app.patch<{
    Params: { sessionId: string };
    Body: { title?: string | null };
  }>('/api/sessions/:sessionId', async (req) => {
    const { title } = req.body;
    const now = new Date().toISOString();
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
      title ?? null,
      now,
      req.params.sessionId,
    );
    const row = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(req.params.sessionId) as SessionRow;
    return toSession(row);
  });
}
