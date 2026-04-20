import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Project } from '@planloom/shared';
import { getDb } from '../db/connection.js';

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
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
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
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
    db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, cwd, now, now);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    return toProject(row);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
