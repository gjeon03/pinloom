import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { writeEntry } from '../services/timeline/store.js';
import { timelineRoutes } from './timeline.js';

let app: FastifyInstance;
const db = getDb();
// Isolate HOME so the route's store calls (which use os.homedir()) never touch
// the real ~/.pinloom/timeline.
const realHome = process.env.HOME;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pinloom-tl-home-'));
  process.env.HOME = tmpHome;
  app = Fastify({ logger: false });
  await app.register(timelineRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
  db.prepare(
    'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'Demo', '/tmp/demo-tl', 't', 't');
});

describe('timeline routes', () => {
  it('lists dates + reads an entry written to the store', async () => {
    const slug = getProjectWikiSlugByProjectId('p1');
    writeEntry(slug, '2026-06-24', '# entry\n작업');
    const dates = await app.inject({ url: '/api/timeline/projects/p1' });
    expect(dates.json()).toEqual({ dates: ['2026-06-24'] });
    const entry = await app.inject({ url: '/api/timeline/projects/p1/entries/2026-06-24' });
    expect((entry.json() as { markdown: string }).markdown).toContain('작업');
  });

  it('404s an unknown project, 400s a bad date', async () => {
    expect((await app.inject({ url: '/api/timeline/projects/nope' })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/api/timeline/projects/p1/entries/bad-date' })).statusCode,
    ).toBe(400);
  });

  it('toggles per-project auto-capture', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/timeline/projects/p1',
      payload: { auto: false },
    });
    expect(res.json()).toEqual({ ok: true, auto: false });
    const row = db.prepare('SELECT timeline_auto FROM projects WHERE id=?').get('p1') as {
      timeline_auto: number;
    };
    expect(row.timeline_auto).toBe(0);
  });

  it('manual capture with no day-sessions returns written=false (no LLM call)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/timeline/projects/p1/capture',
      payload: { date: '2026-06-24' },
    });
    expect(res.json()).toMatchObject({ ok: true, written: false });
  });

  it('aggregates a global date view across projects', async () => {
    db.prepare(
      'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('p2', 'Other', '/tmp/other-tl', 't', 't');
    writeEntry(getProjectWikiSlugByProjectId('p1'), '2026-06-24', 'demo work');
    writeEntry(getProjectWikiSlugByProjectId('p2'), '2026-06-24', 'other work');
    const res = await app.inject({ url: '/api/timeline/date/2026-06-24' });
    const body = res.json() as { entries: { projectName: string }[] };
    expect(body.entries.map((e) => e.projectName).sort()).toEqual(['Demo', 'Other']);
  });
});
