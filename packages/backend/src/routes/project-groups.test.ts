import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ProjectGroup } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { projectGroupRoutes } from './project-groups.js';
import { projectRoutes } from './projects.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(projectGroupRoutes);
  await app.register(projectRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM plan_items;
    DELETE FROM plans;
    DELETE FROM projects;
    DELETE FROM project_groups;
  `);
});

describe('GET /api/project-groups', () => {
  it('returns an empty list when no groups exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project-groups' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns groups ordered by order_index', async () => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO project_groups (id, name, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        'a', 'A', 2, now, now,
        'b', 'B', 0, now, now,
        'c', 'C', 1, now, now,
      );

    const res = await app.inject({ method: 'GET', url: '/api/project-groups' });
    const groups = res.json() as ProjectGroup[];
    expect(groups.map((g) => g.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('POST /api/project-groups', () => {
  it('creates a group and assigns the next order_index', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: 'Work' },
    });
    expect(r1.statusCode).toBe(200);
    const g1 = r1.json() as ProjectGroup;
    expect(g1.name).toBe('Work');
    expect(g1.orderIndex).toBe(0);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: 'Personal' },
    });
    const g2 = r2.json() as ProjectGroup;
    expect(g2.orderIndex).toBe(1);
  });

  it('rejects an empty name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/project-groups/:id', () => {
  it('renames an existing group', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: 'Original' },
    });
    const { id } = created.json() as ProjectGroup;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/project-groups/${id}`,
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ProjectGroup).name).toBe('Renamed');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/project-groups/missing',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty name with 400', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: 'Original' },
    });
    const { id } = created.json() as ProjectGroup;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/project-groups/${id}`,
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/project-groups/:id', () => {
  it('removes the group and sets member projects.group_id to NULL', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/project-groups',
      payload: { name: 'Bucket' },
    });
    const { id: groupId } = created.json() as ProjectGroup;

    const proj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'In Group', cwd: '/tmp/in-group', groupId },
    });
    expect(proj.statusCode).toBe(200);
    const projectId = (proj.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/project-groups/${groupId}`,
    });
    expect(del.statusCode).toBe(200);

    const row = getDb()
      .prepare('SELECT group_id FROM projects WHERE id = ?')
      .get(projectId) as { group_id: string | null } | undefined;
    expect(row?.group_id).toBeNull();
  });
});

describe('POST /api/project-groups/reorder', () => {
  it('rewrites order_index by the input array order', async () => {
    const make = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/project-groups',
        payload: { name },
      });
    const a = (await make('A')).json() as ProjectGroup;
    const b = (await make('B')).json() as ProjectGroup;
    const c = (await make('C')).json() as ProjectGroup;

    const res = await app.inject({
      method: 'POST',
      url: '/api/project-groups/reorder',
      payload: { ids: [c.id, a.id, b.id] },
    });
    expect(res.statusCode).toBe(200);

    const ordered = (res.json() as ProjectGroup[]).map((g) => g.id);
    expect(ordered).toEqual([c.id, a.id, b.id]);
  });

  it('rejects a non-array body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-groups/reorder',
      payload: { ids: 'oops' },
    });
    expect(res.statusCode).toBe(400);
  });
});
