import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PromptTemplate } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface TemplateRow {
  id: string;
  title: string;
  body: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

function toTemplate(row: TemplateRow): PromptTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TITLE_MAX = 200;
const BODY_MAX = 8000;

// Reusable prompt templates — a global (user-level) list, manually ordered.
// CRUD + reorder, modeled on project-notepads / project-groups. Validation
// lives here (codebase convention), not in SQL.
export async function promptTemplateRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/api/prompt-templates', async () => {
    const rows = db
      .prepare(
        'SELECT * FROM prompt_templates ORDER BY order_index ASC, created_at ASC',
      )
      .all() as TemplateRow[];
    return rows.map(toTemplate);
  });

  app.post<{ Body: { title?: unknown; body?: unknown } }>(
    '/api/prompt-templates',
    async (req, reply) => {
      const title =
        typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        reply.code(400);
        return { error: 'title must be a non-empty string' };
      }
      if (title.length > TITLE_MAX) {
        reply.code(400);
        return { error: `title too long (max ${TITLE_MAX} chars)` };
      }
      const body = typeof req.body.body === 'string' ? req.body.body : '';
      if (!body.trim()) {
        reply.code(400);
        return { error: 'body must be a non-empty string' };
      }
      if (body.length > BODY_MAX) {
        reply.code(400);
        return { error: `body too long (max ${BODY_MAX} chars)` };
      }
      const id = nanoid();
      const now = new Date().toISOString();
      // Tail insert: one past the current max order.
      const next = (
        db
          .prepare(
            'SELECT COALESCE(MAX(order_index), -1) AS max FROM prompt_templates',
          )
          .get() as { max: number }
      ).max + 1;
      db.prepare(
        `INSERT INTO prompt_templates (id, title, body, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, title, body, next, now, now);
      const row = db
        .prepare('SELECT * FROM prompt_templates WHERE id = ?')
        .get(id) as TemplateRow;
      reply.code(201);
      return toTemplate(row);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { title?: unknown; body?: unknown };
  }>('/api/prompt-templates/:id', async (req, reply) => {
    const existing = db
      .prepare('SELECT * FROM prompt_templates WHERE id = ?')
      .get(req.params.id) as TemplateRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'template not found' };
    }
    let title = existing.title;
    let body = existing.body;
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim()) {
        reply.code(400);
        return { error: 'title must be a non-empty string' };
      }
      title = req.body.title.trim();
      if (title.length > TITLE_MAX) {
        reply.code(400);
        return { error: `title too long (max ${TITLE_MAX} chars)` };
      }
    }
    if (req.body.body !== undefined) {
      if (typeof req.body.body !== 'string' || !req.body.body.trim()) {
        reply.code(400);
        return { error: 'body must be a non-empty string' };
      }
      body = req.body.body;
      if (body.length > BODY_MAX) {
        reply.code(400);
        return { error: `body too long (max ${BODY_MAX} chars)` };
      }
    }
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE prompt_templates SET title = ?, body = ?, updated_at = ? WHERE id = ?',
    ).run(title, body, now, req.params.id);
    const row = db
      .prepare('SELECT * FROM prompt_templates WHERE id = ?')
      .get(req.params.id) as TemplateRow;
    return toTemplate(row);
  });

  app.delete<{ Params: { id: string } }>(
    '/api/prompt-templates/:id',
    async (req) => {
      // Idempotent (notepad parity): no 404 on a missing row. Explicit user
      // action, so no-auto-deletion is honored.
      db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(req.params.id);
      return { ok: true as const };
    },
  );

  app.post<{ Body: { ids?: unknown } }>(
    '/api/prompt-templates/reorder',
    async (req, reply) => {
      const ids = req.body.ids;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
        reply.code(400);
        return { error: 'ids array is required' };
      }
      // Re-derive a dense, unique 0..n-1 order over ALL rows rather than
      // trusting the input verbatim: requested order first (existing ids,
      // de-duped), then any rows the caller omitted appended in their current
      // order. Robust to partial / duplicate / stale ids — order_index never
      // collides or gaps. order_index is metadata, so leave updated_at alone.
      const update = db.prepare(
        'UPDATE prompt_templates SET order_index = ? WHERE id = ?',
      );
      const reindex = db.transaction((requested: string[]) => {
        const existing = db
          .prepare(
            'SELECT id FROM prompt_templates ORDER BY order_index ASC, created_at ASC',
          )
          .all() as { id: string }[];
        const existingIds = new Set(existing.map((r) => r.id));
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const id of requested) {
          if (existingIds.has(id) && !seen.has(id)) {
            seen.add(id);
            ordered.push(id);
          }
        }
        for (const r of existing) {
          if (!seen.has(r.id)) ordered.push(r.id);
        }
        ordered.forEach((id, i) => update.run(i, id));
      });
      reindex(ids as string[]);
      const rows = db
        .prepare(
          'SELECT * FROM prompt_templates ORDER BY order_index ASC, created_at ASC',
        )
        .all() as TemplateRow[];
      return rows.map(toTemplate);
    },
  );
}
