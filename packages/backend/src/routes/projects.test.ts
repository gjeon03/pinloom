import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Project, ProjectGroup } from '@pinloom/shared';
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

async function createGroup(name: string): Promise<ProjectGroup> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/project-groups',
    payload: { name },
  });
  return res.json() as ProjectGroup;
}

async function createProject(
  name: string,
  cwd: string,
  groupId: string | null = null,
): Promise<Project> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: groupId === null ? { name, cwd } : { name, cwd, groupId },
  });
  return res.json() as Project;
}

describe('POST /api/projects', () => {
  it('creates a project with groupId: null when no group is specified', async () => {
    const proj = await createProject('A', '/a');
    expect(proj.groupId).toBeNull();
    expect(proj.name).toBe('A');
  });

  it('creates a project bound to an existing group', async () => {
    const g = await createGroup('Work');
    const proj = await createProject('A', '/a', g.id);
    expect(proj.groupId).toBe(g.id);
  });

  it('rejects a non-existent groupId with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'A', cwd: '/a', groupId: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/projects', () => {
  it('includes groupId in the response shape', async () => {
    const g = await createGroup('G');
    await createProject('A', '/a', g.id);
    await createProject('B', '/b');

    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    const list = res.json() as Project[];
    expect(list).toHaveLength(2);
    const a = list.find((p) => p.name === 'A');
    const b = list.find((p) => p.name === 'B');
    expect(a?.groupId).toBe(g.id);
    expect(b?.groupId).toBeNull();
  });
});

describe('POST /api/projects/reorder — group + order semantics', () => {
  it('reorders within the ungrouped bucket (legacy flat behavior)', async () => {
    const a = await createProject('A', '/a');
    const b = await createProject('B', '/b');
    const c = await createProject('C', '/c');

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/reorder',
      payload: {
        items: [
          { id: c.id, groupId: null },
          { id: a.id, groupId: null },
          { id: b.id, groupId: null },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const ordered = (res.json() as Project[]).map((p) => p.id);
    // GET returns by order_index ASC, created_at DESC. Within the ungrouped
    // bucket each item now has 0/1/2.
    expect(ordered).toEqual([c.id, a.id, b.id]);
  });

  it('moves a project across groups in a single call', async () => {
    const work = await createGroup('Work');
    const personal = await createGroup('Personal');
    const a = await createProject('A', '/a', work.id);
    const b = await createProject('B', '/b', work.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/reorder',
      payload: {
        items: [
          { id: a.id, groupId: personal.id },
          { id: b.id, groupId: work.id },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const after = res.json() as Project[];
    const aAfter = after.find((p) => p.id === a.id);
    const bAfter = after.find((p) => p.id === b.id);
    expect(aAfter?.groupId).toBe(personal.id);
    expect(bAfter?.groupId).toBe(work.id);
  });

  it('assigns per-group contiguous order_index starting at 0', async () => {
    const work = await createGroup('Work');
    const personal = await createGroup('Personal');
    const w1 = await createProject('W1', '/w1', work.id);
    const w2 = await createProject('W2', '/w2', work.id);
    const p1 = await createProject('P1', '/p1', personal.id);

    await app.inject({
      method: 'POST',
      url: '/api/projects/reorder',
      payload: {
        items: [
          { id: w1.id, groupId: work.id },
          { id: w2.id, groupId: work.id },
          { id: p1.id, groupId: personal.id },
        ],
      },
    });

    const rows = getDb()
      .prepare(
        'SELECT id, group_id, order_index FROM projects ORDER BY group_id, order_index',
      )
      .all() as { id: string; group_id: string; order_index: number }[];

    const byId = Object.fromEntries(
      rows.map((r) => [r.id, { groupId: r.group_id, order: r.order_index }]),
    );
    expect(byId[w1.id]).toEqual({ groupId: work.id, order: 0 });
    expect(byId[w2.id]).toEqual({ groupId: work.id, order: 1 });
    expect(byId[p1.id]).toEqual({ groupId: personal.id, order: 0 });
  });

  it('rejects items referencing non-existent groups with 400', async () => {
    const a = await createProject('A', '/a');

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/reorder',
      payload: {
        items: [{ id: a.id, groupId: 'phantom' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-array body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/reorder',
      payload: { items: 'oops' },
    });
    expect(res.statusCode).toBe(400);
  });
});
