import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { searchRoutes } from './search.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(searchRoutes);
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
    DELETE FROM projects;
  `);
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'Proj One', '/tmp/search-p1', 't', 't');
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('s1', 'p1', 'S1', 't', 't');
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)',
  ).run('m1', 's1', 'user', 'deploy the 배포 pipeline', 't');
});

async function search(qs: string) {
  const res = await app.inject({ method: 'GET', url: `/api/search${qs}` });
  return { status: res.statusCode, body: res.json() as { results: unknown[] } };
}

describe('GET /api/search', () => {
  it('returns matching messages for a query', async () => {
    const { status, body } = await search('?q=deploy');
    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect((body.results[0] as { messageId: string }).messageId).toBe('m1');
  });

  it('returns empty results for a blank query (no 500)', async () => {
    const { status, body } = await search('?q=%20%20');
    expect(status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it('serves a 2-char Korean query via the LIKE fallback', async () => {
    const { body } = await search('?q=%EB%B0%B0%ED%8F%AC'); // 배포
    expect(body.results).toHaveLength(1);
  });

  it('scopes by projectId', async () => {
    const hit = await search('?q=deploy&projectId=p1');
    expect(hit.body.results).toHaveLength(1);
    const miss = await search('?q=deploy&projectId=nope');
    expect(miss.body.results).toHaveLength(0);
  });

  it('does not 500 on a query full of FTS operators', async () => {
    const { status } = await search('?q=' + encodeURIComponent('AND OR NEAR('));
    expect(status).toBe(200);
  });
});
