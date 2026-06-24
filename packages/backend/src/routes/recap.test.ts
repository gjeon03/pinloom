import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { recapRoutes } from './recap.js';

// These exercise only the validation + graceful empty-corpus paths, which never
// invoke the LLM (zero hits / empty range short-circuit before runRecap).
let app: FastifyInstance;
const db = getDb();
const realHome = process.env.HOME;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pinloom-recap-rt-'));
  process.env.HOME = tmpHome;
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
  app = Fastify({ logger: false });
  await app.register(recapRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('recap routes', () => {
  it('400s ask without a question', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/recap/ask', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('answers gracefully when the corpus has no hits (no LLM)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/recap/ask',
      payload: { question: 'nonexistentkeyword' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sources: [] });
  });

  it('400s generate with a bad kind or bad dates', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/recap/generate', payload: { kind: 'x', dateFrom: '2026-06-01', dateTo: '2026-06-30' } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/recap/generate', payload: { kind: 'detailed', dateFrom: 'bad', dateTo: '2026-06-30' } })).statusCode,
    ).toBe(400);
  });

  it('returns empty for a range with no timeline entries (no LLM)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/recap/generate',
      payload: { kind: 'detailed', dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ empty: true });
  });
});
