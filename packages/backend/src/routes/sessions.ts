import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Message, MessageRole, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import type { ImageInput, ImageMediaType } from '../services/runner.js';
import { cancelAiRun, isAiRunning, sendUserMessage } from '../services/runner.js';
import { cancelExecRun, execShellCommand, isExecRunning } from '../services/exec.js';
import { handoffFromSession, injectPinIntoSession } from '../services/handoff.js';
import { runWikiSync } from '../services/wiki-sync.js';

const ALLOWED_IMAGE_MIME: ReadonlySet<ImageMediaType> = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function parseImages(raw: unknown): ImageInput[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'images must be an array' };
  const parsed: ImageInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'each image must be an object' };
    }
    const mime = (item as { mimeType?: unknown }).mimeType;
    const base64 = (item as { base64?: unknown }).base64;
    if (typeof mime !== 'string' || typeof base64 !== 'string') {
      return { error: 'image.mimeType and image.base64 are required strings' };
    }
    if (!ALLOWED_IMAGE_MIME.has(mime as ImageMediaType)) {
      return { error: `unsupported image mime type: ${mime}` };
    }
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return { error: `image exceeds ${MAX_IMAGE_BYTES} bytes` };
    }
    parsed.push({ mimeType: mime as ImageMediaType, base64 });
  }
  return parsed;
}

interface SessionRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  agent: string;
  agent_session_id: string | null;
  // Legacy column kept in sync with agent_session_id; will be dropped later.
  claude_session_id: string | null;
  title: string | null;
  next_image_number: number;
  last_synced_message_id: string | null;
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
  pinned_at: string | null;
  source_message_id: string | null;
  model: string | null;
  created_at: string;
}

export function toSession(row: SessionRow): Session {
  const agent = row.agent === 'codex' ? 'codex' : 'claude';
  // agent_session_id is the canonical resume token going forward; fall back
  // to claude_session_id for any rows the migration backfill missed.
  const agentSessionId = row.agent_session_id ?? row.claude_session_id;
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
    pinnedAt: row.pinned_at,
    sourceMessageId: row.source_message_id,
    model: row.model,
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
        .prepare(
          'SELECT * FROM sessions WHERE project_id = ? ORDER BY order_index ASC, created_at ASC',
        )
        .all(req.params.projectId) as SessionRow[];
      return rows.map(toSession);
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      planId?: string | null;
      title?: string | null;
      agent?: 'claude' | 'codex';
    };
  }>('/api/projects/:projectId/sessions', async (req, reply) => {
    const agent = req.body.agent === 'codex' ? 'codex' : 'claude';
    if (req.body.agent && req.body.agent !== 'claude' && req.body.agent !== 'codex') {
      reply.code(400);
      return { error: `unknown agent: ${req.body.agent}` };
    }
    const id = nanoid();
    const now = new Date().toISOString();
    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(order_index), -1) AS max FROM sessions WHERE project_id = ?',
      )
      .get(req.params.projectId) as { max: number };
    const nextOrder = maxRow.max + 1;
    db.prepare(
      `INSERT INTO sessions
         (id, project_id, plan_id, agent, claude_session_id, agent_session_id, title, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      id,
      req.params.projectId,
      req.body.planId ?? null,
      agent,
      req.body.title ?? null,
      nextOrder,
      now,
      now,
    );
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
    return toSession(row);
  });

  app.post<{
    Params: { projectId: string };
    Body: { ids: string[] };
  }>('/api/projects/:projectId/sessions/reorder', async (req, reply) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      reply.code(400);
      return { error: 'ids array is required' };
    }
    const now = new Date().toISOString();
    const update = db.prepare(
      'UPDATE sessions SET order_index = ?, updated_at = ? WHERE id = ? AND project_id = ?',
    );
    const tx = db.transaction((list: string[]) => {
      list.forEach((id, i) => update.run(i, now, id, req.params.projectId));
    });
    tx(ids);

    const rows = db
      .prepare(
        'SELECT * FROM sessions WHERE project_id = ? ORDER BY order_index ASC, created_at ASC',
      )
      .all(req.params.projectId) as SessionRow[];
    return rows.map(toSession);
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
    Body: {
      content: string;
      planItemId?: string | null;
      images?: Array<{ mimeType: string; base64: string }>;
      model?: string;
    };
  }>(
    '/api/sessions/:sessionId/messages',
    { bodyLimit: 30 * 1024 * 1024 },
    async (req, reply) => {
      const { content, planItemId = null, images: imagesRaw, model } = req.body;
      const imagesParsed = parseImages(imagesRaw);
      if ('error' in imagesParsed) {
        reply.code(400);
        return { error: imagesParsed.error };
      }
      const hasContent = !!content && content.trim().length > 0;
      if (!hasContent && imagesParsed.length === 0) {
        reply.code(400);
        return { error: 'content or images is required' };
      }
      const cleanModel = typeof model === 'string' && model.trim().length > 0 ? model : undefined;
      try {
        const msg = await sendUserMessage(
          req.params.sessionId,
          content ?? '',
          planItemId,
          imagesParsed,
          cleanModel,
        );
        return msg;
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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

  app.post<{
    Params: { sessionId: string };
    Body: { model?: string };
  }>('/api/sessions/:sessionId/wiki-sync', async (req, reply) => {
    try {
      const result = await runWikiSync({
        sessionId: req.params.sessionId,
        model: req.body?.model,
      });
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
