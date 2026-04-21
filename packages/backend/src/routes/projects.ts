import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Project } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function projectRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/api/projects', async () => {
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY order_index ASC, created_at DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  });

  app.post<{ Body: { name: string; cwd: string } }>('/api/projects', async (req, reply) => {
    const { name, cwd } = req.body;
    if (!name || !cwd) {
      reply.code(400);
      return { error: 'name and cwd are required' };
    }
    const id = nanoid();
    const now = new Date().toISOString();
    // New projects land at the top (smallest order_index)
    const minRow = db
      .prepare('SELECT COALESCE(MIN(order_index), 0) AS min FROM projects')
      .get() as { min: number };
    const nextOrder = minRow.min - 1;
    db.prepare(
      'INSERT INTO projects (id, name, cwd, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name, cwd, nextOrder, now, now);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    return toProject(row);
  });

  app.post<{ Body: { ids: string[] } }>('/api/projects/reorder', async (req, reply) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      reply.code(400);
      return { error: 'ids array is required' };
    }
    const now = new Date().toISOString();
    const update = db.prepare(
      'UPDATE projects SET order_index = ?, updated_at = ? WHERE id = ?',
    );
    const tx = db.transaction((list: string[]) => {
      list.forEach((id, i) => update.run(i, now, id));
    });
    tx(ids);

    const rows = db
      .prepare('SELECT * FROM projects ORDER BY order_index ASC, created_at DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string };
  }>('/api/projects/:id', async (req, reply) => {
    const existing = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(req.params.id) as ProjectRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const nextName = req.body.name?.trim();
    if (nextName !== undefined && nextName.length === 0) {
      reply.code(400);
      return { error: 'name cannot be empty' };
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(
      nextName ?? existing.name,
      now,
      req.params.id,
    );
    const row = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(req.params.id) as ProjectRow;
    return toProject(row);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
