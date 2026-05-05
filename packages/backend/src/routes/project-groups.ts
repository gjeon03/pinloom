import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { ProjectGroup } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface ProjectGroupRow {
  id: string;
  name: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

function toGroup(row: ProjectGroupRow): ProjectGroup {
  return {
    id: row.id,
    name: row.name,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function projectGroupRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/api/project-groups', async () => {
    const rows = db
      .prepare(
        'SELECT * FROM project_groups ORDER BY order_index ASC, created_at ASC',
      )
      .all() as ProjectGroupRow[];
    return rows.map(toGroup);
  });

  app.post<{ Body: { name: string } }>(
    '/api/project-groups',
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) {
        reply.code(400);
        return { error: 'name is required' };
      }
      const id = nanoid();
      const now = new Date().toISOString();
      // New groups land at the end (largest order_index + 1)
      const maxRow = db
        .prepare('SELECT COALESCE(MAX(order_index), -1) AS max FROM project_groups')
        .get() as { max: number };
      const nextOrder = maxRow.max + 1;
      db.prepare(
        `INSERT INTO project_groups (id, name, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, name, nextOrder, now, now);
      const row = db
        .prepare('SELECT * FROM project_groups WHERE id = ?')
        .get(id) as ProjectGroupRow;
      return toGroup(row);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string };
  }>('/api/project-groups/:id', async (req, reply) => {
    const existing = db
      .prepare('SELECT * FROM project_groups WHERE id = ?')
      .get(req.params.id) as ProjectGroupRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'group not found' };
    }
    const nextName = req.body.name?.trim();
    if (nextName !== undefined && nextName.length === 0) {
      reply.code(400);
      return { error: 'name cannot be empty' };
    }
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE project_groups SET name = ?, updated_at = ? WHERE id = ?',
    ).run(nextName ?? existing.name, now, req.params.id);
    const row = db
      .prepare('SELECT * FROM project_groups WHERE id = ?')
      .get(req.params.id) as ProjectGroupRow;
    return toGroup(row);
  });

  app.delete<{ Params: { id: string } }>(
    '/api/project-groups/:id',
    async (req) => {
      // Member projects are preserved; their group_id is set to NULL by FK.
      db.prepare('DELETE FROM project_groups WHERE id = ?').run(req.params.id);
      return { ok: true as const };
    },
  );

  app.post<{ Body: { ids: string[] } }>(
    '/api/project-groups/reorder',
    async (req, reply) => {
      const { ids } = req.body ?? { ids: [] };
      if (!Array.isArray(ids)) {
        reply.code(400);
        return { error: 'ids array is required' };
      }
      const now = new Date().toISOString();
      const update = db.prepare(
        'UPDATE project_groups SET order_index = ?, updated_at = ? WHERE id = ?',
      );
      const tx = db.transaction((list: string[]) => {
        list.forEach((id, i) => update.run(i, now, id));
      });
      tx(ids);

      const rows = db
        .prepare(
          'SELECT * FROM project_groups ORDER BY order_index ASC, created_at ASC',
        )
        .all() as ProjectGroupRow[];
      return rows.map(toGroup);
    },
  );
}
