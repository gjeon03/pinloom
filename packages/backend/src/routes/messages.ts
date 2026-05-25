import type { FastifyInstance } from 'fastify';
import type { Message } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';
import { summarizeForPin, toMessage } from './sessions.js';

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

function broadcastUpdate(message: Message) {
  broadcast(`session:${message.sessionId}`, {
    type: 'message_updated',
    sessionId: message.sessionId,
    message,
  });
}

export async function messageRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/pins',
    async (req) => {
      const rows = db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND pinned = 1
           ORDER BY COALESCE(pinned_at, created_at) ASC`,
        )
        .all(req.params.sessionId) as MessageRow[];
      return rows.map(toMessage);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { pinned?: boolean; pinTitle?: string | null };
  }>('/api/messages/:id', async (req, reply) => {
    const existing = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id) as MessageRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }

    let nextPinned = existing.pinned;
    let nextTitle = existing.pin_title;
    let nextPinnedAt = existing.pinned_at;

    if (typeof req.body.pinned === 'boolean') {
      const willPin = req.body.pinned;
      nextPinned = willPin ? 1 : 0;
      if (willPin) {
        if (!nextTitle) nextTitle = summarizeForPin(existing.content);
        if (!nextPinnedAt) nextPinnedAt = new Date().toISOString();
      } else {
        nextTitle = null;
        nextPinnedAt = null;
      }
    }

    if (req.body.pinTitle !== undefined) {
      nextTitle = req.body.pinTitle;
    }

    db.prepare(
      'UPDATE messages SET pinned = ?, pin_title = ?, pinned_at = ? WHERE id = ?',
    ).run(nextPinned, nextTitle, nextPinnedAt, req.params.id);

    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id) as MessageRow;
    const message = toMessage(row);
    broadcastUpdate(message);
    return message;
  });

  // Resolve the source-of-truth coordinates for a message that was
  // copied here via "Send pin to…". The frontend uses this to render
  // a clickable "jump to original" badge on the injected pin. Returns
  // null shape (404) when the source row no longer exists (deleted
  // session or message).
  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/source',
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT m.id, m.session_id, s.project_id, s.title AS session_title,
                  p.name AS project_name
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN projects p ON p.id = s.project_id
            WHERE m.id = ?`,
        )
        .get(req.params.id) as
        | {
            id: string;
            session_id: string;
            project_id: string;
            session_title: string | null;
            project_name: string;
          }
        | undefined;
      if (!row) {
        reply.code(404);
        return { error: 'source message not found' };
      }
      return {
        messageId: row.id,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        projectId: row.project_id,
        projectName: row.project_name,
      };
    },
  );
}
