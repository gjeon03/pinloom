import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Project } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  group_id: string | null;
  order_index: number;
  timeline_auto: number | null;
  wiki_auto: number | null;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    groupId: row.group_id,
    // Default true for legacy rows (timeline_auto: migration 33, wiki_auto: 36).
    timelineAuto: row.timeline_auto !== 0,
    wikiAuto: row.wiki_auto !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ReorderItem {
  id: string;
  groupId: string | null;
}

export async function projectRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/api/projects', async () => {
    // Hidden projects (the bot host) never surface in the sidebar / pickers.
    const rows = db
      .prepare(
        'SELECT * FROM projects WHERE hidden = 0 ORDER BY order_index ASC, created_at DESC',
      )
      .all() as ProjectRow[];
    return rows.map(toProject);
  });

  app.post<{
    Body: { name: string; cwd: string; groupId?: string | null };
  }>('/api/projects', async (req, reply) => {
    const { name, cwd, groupId } = req.body;
    if (!name || !cwd) {
      reply.code(400);
      return { error: 'name and cwd are required' };
    }
    const resolvedGroupId = groupId ?? null;
    if (resolvedGroupId !== null) {
      const groupExists = db
        .prepare('SELECT 1 FROM project_groups WHERE id = ?')
        .get(resolvedGroupId);
      if (!groupExists) {
        reply.code(400);
        return { error: 'group does not exist' };
      }
    }
    const id = nanoid();
    const now = new Date().toISOString();
    // New projects land at the top of their bucket (smallest order_index).
    const minRow = db
      .prepare(
        `SELECT COALESCE(MIN(order_index), 0) AS min
         FROM projects
         WHERE ${resolvedGroupId === null ? 'group_id IS NULL' : 'group_id = ?'}`,
      )
      .get(...(resolvedGroupId === null ? [] : [resolvedGroupId])) as { min: number };
    const nextOrder = minRow.min - 1;
    db.prepare(
      `INSERT INTO projects (id, name, cwd, group_id, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, cwd, resolvedGroupId, nextOrder, now, now);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    return toProject(row);
  });

  app.post<{ Body: { items: ReorderItem[] } }>(
    '/api/projects/reorder',
    async (req, reply) => {
      const { items } = req.body ?? { items: [] };
      if (!Array.isArray(items)) {
        reply.code(400);
        return { error: 'items array is required' };
      }
      // Validate referenced groups exist (NULL is fine — that is the
      // ungrouped bucket).
      const referencedGroups = new Set(
        items.map((it) => it.groupId).filter((g): g is string => g !== null && g !== undefined),
      );
      if (referencedGroups.size > 0) {
        const placeholders = Array.from(referencedGroups).map(() => '?').join(',');
        const found = db
          .prepare(
            `SELECT id FROM project_groups WHERE id IN (${placeholders})`,
          )
          .all(...referencedGroups) as { id: string }[];
        if (found.length !== referencedGroups.size) {
          reply.code(400);
          return { error: 'one or more groups do not exist' };
        }
      }

      // Walk per-group, assigning 0,1,2... so each bucket gets a contiguous
      // ordering. order_index is per-group, queries always filter by group_id.
      const now = new Date().toISOString();
      const update = db.prepare(
        'UPDATE projects SET group_id = ?, order_index = ?, updated_at = ? WHERE id = ?',
      );
      const tx = db.transaction((list: ReorderItem[]) => {
        const counters = new Map<string | null, number>();
        for (const it of list) {
          const key = it.groupId ?? null;
          const idx = counters.get(key) ?? 0;
          update.run(key, idx, now, it.id);
          counters.set(key, idx + 1);
        }
      });
      tx(items);

      const rows = db
        .prepare(
          'SELECT * FROM projects WHERE hidden = 0 ORDER BY order_index ASC, created_at DESC',
        )
        .all() as ProjectRow[];
      return rows.map(toProject);
    },
  );

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
