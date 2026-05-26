import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Message, MessageRole, Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import type { ImageInput, ImageMediaType } from '../services/runner.js';
import {
  cancelAiRun,
  isAiRunning,
  sendUserMessage,
  sendUserMessages,
  tryDrainQueue,
} from '../services/runner.js';
import {
  broadcastQueueState,
  clearQueue,
  enqueueMessage,
  InvalidQueueContentError,
  listQueueItems,
  removeQueueItem,
  SessionNotFoundError,
} from '../services/message-queue.js';
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
  model: string | null;
  reasoning_effort: string | null;
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

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function normalizeEffort(value: string | null): Session['reasoningEffort'] {
  if (value && VALID_EFFORTS.has(value)) {
    return value as Session['reasoningEffort'];
  }
  return null;
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
    model: row.model,
    reasoningEffort: normalizeEffort(row.reasoning_effort),
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

  // Cross-project session list. Used by the Teams UI (and PR2's MCP
  // server) to resolve session metadata without iterating projects.
  app.get('/api/sessions', async () => {
    const rows = db
      .prepare(
        'SELECT * FROM sessions ORDER BY project_id ASC, order_index ASC, created_at ASC',
      )
      .all() as SessionRow[];
    return rows.map(toSession);
  });

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

  // Drains a frontend-side queue: persists each message as its own USER row
  // (so the chat shows N bubbles) but pushes ONE combined prompt to the
  // agent so it answers all of them in a single turn — same UX shape as
  // Claude Code's mid-task message stacking.
  app.post<{
    Params: { sessionId: string };
    Body: {
      messages: Array<{
        content: string;
        planItemId?: string | null;
        images?: unknown;
      }>;
      model?: string;
      interrupt?: boolean;
    };
  }>(
    '/api/sessions/:sessionId/messages/batch',
    { bodyLimit: 60 * 1024 * 1024 },
    async (req, reply) => {
      const { messages, model, interrupt } = req.body ?? {};
      if (!Array.isArray(messages) || messages.length === 0) {
        reply.code(400);
        return { error: 'messages must be a non-empty array' };
      }
      const parsed: Array<{
        content: string;
        planItemId: string | null;
        images: ImageInput[];
      }> = [];
      for (const m of messages) {
        const imagesParsed = parseImages(m.images);
        if ('error' in imagesParsed) {
          reply.code(400);
          return { error: imagesParsed.error };
        }
        const content = typeof m.content === 'string' ? m.content : '';
        if (content.trim().length === 0 && imagesParsed.length === 0) {
          reply.code(400);
          return { error: 'each message needs content or images' };
        }
        parsed.push({
          content,
          planItemId: m.planItemId ?? null,
          images: imagesParsed,
        });
      }
      const cleanModel =
        typeof model === 'string' && model.trim().length > 0 ? model : undefined;
      try {
        return await sendUserMessages(req.params.sessionId, parsed, cleanModel, {
          interrupt: interrupt === true,
        });
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

  // Pending message queue. The frontend mirrors this list via `queue_updated`
  // WS broadcasts; HTTP is just for the initial fetch on session load and
  // for explicit user actions (manual remove). All drains are backend-driven
  // — at every agent turn boundary, runner pulls the queue and splices it
  // into the agent.
  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/queue',
    async (req) => {
      return listQueueItems(req.params.sessionId);
    },
  );

  app.post<{
    Params: { sessionId: string };
    Body: { content: string; model?: string | null };
  }>('/api/sessions/:sessionId/queue', async (req, reply) => {
    const { content, model } = req.body ?? {};
    if (typeof content !== 'string') {
      reply.code(400);
      return { error: 'content must be a string' };
    }
    const cleanModel =
      typeof model === 'string' && model.trim().length > 0 ? model : null;

    let item;
    try {
      item = enqueueMessage({
        sessionId: req.params.sessionId,
        content,
        model: cleanModel,
      });
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof InvalidQueueContentError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }

    // Drain immediately when the agent isn't actively producing output —
    // that covers both "no run yet" (kick-starts a fresh run) and "run
    // alive but idle between turns" (push to the existing run so the agent
    // takes the next prompt without waiting on a runner event that won't
    // fire). When the agent IS in flight, we hold the queue here and let
    // the runner's own boundary events drain it, so the queue stays
    // visible in the UI in the meantime.
    if (!isAiRunning(req.params.sessionId)) {
      // Skip the post-enqueue broadcast: tryDrainQueue immediately drains
      // and broadcasts the (now empty) state, so an extra broadcast here
      // would cause a one-frame "Queued (1) → 0" flicker in the UI.
      tryDrainQueue(req.params.sessionId);
    } else {
      broadcastQueueState(req.params.sessionId);
    }
    return item;
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/queue',
    async (req) => {
      // Bulk clear — single broadcast at the end. Used by the chat UI's
      // "Clear all" button so we don't fire N parallel DELETEs (one
      // broadcast per row) when the queue holds many items.
      clearQueue(req.params.sessionId);
      broadcastQueueState(req.params.sessionId);
      return { ok: true as const };
    },
  );

  app.delete<{ Params: { sessionId: string; itemId: string } }>(
    '/api/sessions/:sessionId/queue/:itemId',
    async (req, reply) => {
      const removed = removeQueueItem(
        req.params.sessionId,
        req.params.itemId,
      );
      if (!removed) {
        reply.code(404);
        return { error: 'queue item not found' };
      }
      broadcastQueueState(req.params.sessionId);
      return { ok: true as const };
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
      const { sessionId } = req.params;
      // Stop any in-flight or idle agent run before deleting the session
      // row. If we don't, the run keeps streaming events / persisting
      // tool/assistant rows and they cascade-delete out from under it,
      // producing FK errors and orphan in-memory state.
      cancelAiRun(sessionId);
      cancelExecRun(sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return { ok: true };
    },
  );

  app.patch<{
    Params: { sessionId: string };
    Body: {
      title?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
    };
  }>('/api/sessions/:sessionId', async (req, reply) => {
    const existing = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(req.params.sessionId) as SessionRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const nextTitle =
      req.body.title === undefined ? existing.title : req.body.title;
    const nextModel =
      req.body.model === undefined
        ? existing.model
        : req.body.model && req.body.model.length > 0
          ? req.body.model
          : null;
    let nextEffort = existing.reasoning_effort;
    if (req.body.reasoningEffort !== undefined) {
      if (req.body.reasoningEffort === null || req.body.reasoningEffort === '') {
        nextEffort = null;
      } else if (VALID_EFFORTS.has(req.body.reasoningEffort)) {
        nextEffort = req.body.reasoningEffort;
      } else {
        reply.code(400);
        return { error: `invalid reasoningEffort: ${req.body.reasoningEffort}` };
      }
    }
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE sessions SET title = ?, model = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?',
    ).run(nextTitle, nextModel, nextEffort, now, req.params.sessionId);
    const row = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(req.params.sessionId) as SessionRow;
    return toSession(row);
  });

  // Move a session to a different project. Use case: a chat that
  // bootstrapped a new repo should follow that repo into its own
  // pinloom project. We clear plan_id (plans are project-scoped) and
  // — to honor the "projects are never empty" UX — auto-create a
  // fresh untitled session in the source project if the move would
  // leave it with zero tabs.
  app.post<{
    Params: { sessionId: string };
    Body: { projectId?: string };
  }>('/api/sessions/:sessionId/move', async (req, reply) => {
    const targetProjectId = req.body?.projectId?.trim();
    if (!targetProjectId) {
      reply.code(400);
      return { error: 'projectId is required' };
    }
    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(req.params.sessionId) as SessionRow | undefined;
    if (!session) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const target = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(targetProjectId) as { id: string } | undefined;
    if (!target) {
      reply.code(404);
      return { error: 'target project not found' };
    }
    if (session.project_id === targetProjectId) {
      reply.code(400);
      return { error: 'session already belongs to that project' };
    }

    const sourceProjectId = session.project_id;
    const now = new Date().toISOString();

    let sourceFiller: SessionRow | null = null;
    db.transaction(() => {
      // New tab lands at the bottom of the target project's strip.
      const maxRow = db
        .prepare(
          'SELECT COALESCE(MAX(order_index), -1) AS max FROM sessions WHERE project_id = ?',
        )
        .get(targetProjectId) as { max: number };
      db.prepare(
        `UPDATE sessions
         SET project_id = ?,
             plan_id = NULL,
             order_index = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(targetProjectId, maxRow.max + 1, now, req.params.sessionId);

      const remaining = db
        .prepare(
          'SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?',
        )
        .get(sourceProjectId) as { n: number };
      if (remaining.n === 0) {
        const fillerId = nanoid();
        db.prepare(
          `INSERT INTO sessions
             (id, project_id, plan_id, agent, claude_session_id, agent_session_id, title, order_index, created_at, updated_at)
           VALUES (?, ?, NULL, 'claude', NULL, NULL, NULL, 0, ?, ?)`,
        ).run(fillerId, sourceProjectId, now, now);
        sourceFiller = db
          .prepare('SELECT * FROM sessions WHERE id = ?')
          .get(fillerId) as SessionRow;
      }
    })();

    const moved = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(req.params.sessionId) as SessionRow;

    return {
      session: toSession(moved),
      sourceFiller: sourceFiller ? toSession(sourceFiller) : null,
    };
  });
}
