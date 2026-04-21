import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Plan, PlanItem, PlanItemStatus, PlanStatus } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';

interface PlanRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PlanItemRow {
  id: string;
  plan_id: string;
  parent_id: string | null;
  order_index: number;
  title: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as PlanStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: PlanItemRow): PlanItem {
  return {
    id: row.id,
    planId: row.plan_id,
    parentId: row.parent_id,
    orderIndex: row.order_index,
    title: row.title,
    body: row.body,
    status: row.status as PlanItemStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function planRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/plans', async (req) => {
    const rows = db
      .prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC')
      .all(req.params.projectId) as PlanRow[];
    return rows.map(toPlan);
  });

  app.post<{ Params: { projectId: string }; Body: { title: string } }>(
    '/api/projects/:projectId/plans',
    async (req, reply) => {
      const { title } = req.body;
      if (!title) {
        reply.code(400);
        return { error: 'title is required' };
      }
      const id = nanoid();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO plans (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, req.params.projectId, title, 'draft', now, now);
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow;
      return toPlan(row);
    },
  );

  app.get<{ Params: { planId: string } }>('/api/plans/:planId/items', async (req) => {
    const rows = db
      .prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY order_index ASC')
      .all(req.params.planId) as PlanItemRow[];
    return rows.map(toItem);
  });

  app.post<{
    Params: { planId: string };
    Body: { title: string; body?: string; parentId?: string | null };
  }>('/api/plans/:planId/items', async (req, reply) => {
    const { title, body = '', parentId = null } = req.body;
    if (!title) {
      reply.code(400);
      return { error: 'title is required' };
    }
    const id = nanoid();
    const now = new Date().toISOString();
    const max = db
      .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM plan_items WHERE plan_id = ?')
      .get(req.params.planId) as { m: number };
    db.prepare(
      `INSERT INTO plan_items
         (id, plan_id, parent_id, order_index, title, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.params.planId, parentId, max.m + 1, title, body, 'todo', now, now);
    const row = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id) as PlanItemRow;
    const item = toItem(row);
    broadcast(`plan:${req.params.planId}`, {
      type: 'plan_item_updated',
      planId: req.params.planId,
      item,
    });
    return item;
  });

  app.patch<{
    Params: { itemId: string };
    Body: Partial<Pick<PlanItem, 'title' | 'body' | 'status' | 'orderIndex'>>;
  }>('/api/plan-items/:itemId', async (req) => {
    const existing = db
      .prepare('SELECT * FROM plan_items WHERE id = ?')
      .get(req.params.itemId) as PlanItemRow | undefined;
    if (!existing) return { error: 'not found' };

    const next = {
      title: req.body.title ?? existing.title,
      body: req.body.body ?? existing.body,
      status: req.body.status ?? existing.status,
      order_index: req.body.orderIndex ?? existing.order_index,
      updated_at: new Date().toISOString(),
    };
    db.prepare(
      'UPDATE plan_items SET title = ?, body = ?, status = ?, order_index = ?, updated_at = ? WHERE id = ?',
    ).run(next.title, next.body, next.status, next.order_index, next.updated_at, req.params.itemId);
    const row = db
      .prepare('SELECT * FROM plan_items WHERE id = ?')
      .get(req.params.itemId) as PlanItemRow;
    const item = toItem(row);
    broadcast(`plan:${item.planId}`, {
      type: 'plan_item_updated',
      planId: item.planId,
      item,
    });
    return item;
  });

  app.delete<{ Params: { itemId: string } }>('/api/plan-items/:itemId', async (req) => {
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(req.params.itemId);
    return { ok: true };
  });
}
