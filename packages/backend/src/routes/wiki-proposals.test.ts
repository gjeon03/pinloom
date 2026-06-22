import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { wikiProposalRoutes } from './wiki-proposals.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(wikiProposalRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  getDb().exec('DELETE FROM wiki_proposals;');
});

describe('wiki proposals route wiring', () => {
  it('lists empty when there are none', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/wiki/proposals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('maps a missing proposal to 404 (diff / accept / reject)', async () => {
    for (const url of [
      '/api/wiki/proposals/nope',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    for (const url of [
      '/api/wiki/proposals/nope/accept',
      '/api/wiki/proposals/nope/reject',
    ]) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toContain('not found');
    }
  });

  it('filters the list by status', async () => {
    const now = '2026-06-22T00:00:00.000Z';
    getDb()
      .prepare(
        `INSERT INTO wiki_proposals (id, kind, status, title, rel_path, payload, base_hash, created_at, updated_at)
         VALUES ('x','edit_section','rejected','t','p.md','{}',NULL,?,?)`,
      )
      .run(now, now);
    expect(
      (await app.inject({ method: 'GET', url: '/api/wiki/proposals?status=pending' }))
        .json(),
    ).toEqual([]);
    expect(
      (
        (await app.inject({
          method: 'GET',
          url: '/api/wiki/proposals?status=rejected',
        })).json() as unknown[]
      ).length,
    ).toBe(1);
  });
});
