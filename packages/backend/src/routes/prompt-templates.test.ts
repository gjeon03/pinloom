import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PromptTemplate } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { promptTemplateRoutes } from './prompt-templates.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(promptTemplateRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  getDb().exec('DELETE FROM prompt_templates;');
});

async function create(title: string, body: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/prompt-templates',
    payload: { title, body },
  });
  return { status: res.statusCode, tpl: res.json() as PromptTemplate };
}

async function list() {
  const res = await app.inject({ method: 'GET', url: '/api/prompt-templates' });
  return res.json() as PromptTemplate[];
}

describe('prompt templates CRUD', () => {
  it('creates, lists, and tail-orders', async () => {
    const a = await create('Review', 'Review this diff for bugs');
    expect(a.status).toBe(201);
    expect(a.tpl.title).toBe('Review');
    expect(a.tpl.orderIndex).toBe(0);
    const b = await create('Commit', 'Write a conventional commit');
    expect(b.tpl.orderIndex).toBe(1);
    const all = await list();
    expect(all.map((t) => t.title)).toEqual(['Review', 'Commit']);
  });

  it('trims the title and rejects empty title/body', async () => {
    expect((await create('  Spaced  ', 'x')).tpl.title).toBe('Spaced');
    expect((await create('', 'body')).status).toBe(400);
    expect((await create('title', '   ')).status).toBe(400);
  });

  it('rejects over-long title/body', async () => {
    expect((await create('t'.repeat(201), 'b')).status).toBe(400);
    expect((await create('t', 'b'.repeat(8001))).status).toBe(400);
  });

  it('patches partially and bumps updated_at', async () => {
    const { tpl } = await create('Old', 'old body');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/prompt-templates/${tpl.id}`,
      payload: { title: 'New' },
    });
    const patched = res.json() as PromptTemplate;
    expect(patched.title).toBe('New');
    expect(patched.body).toBe('old body'); // unchanged
  });

  it('404s a PATCH to a missing template', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prompt-templates/nope',
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes idempotently', async () => {
    const { tpl } = await create('Gone', 'soon');
    const d1 = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-templates/${tpl.id}`,
    });
    expect(d1.statusCode).toBe(200);
    expect((await list()).length).toBe(0);
    const d2 = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-templates/${tpl.id}`,
    });
    expect(d2.statusCode).toBe(200); // idempotent
  });

  it('reorders by id list', async () => {
    const a = await create('A', 'a');
    const b = await create('B', 'b');
    const c = await create('C', 'c');
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-templates/reorder',
      payload: { ids: [c.tpl.id, a.tpl.id, b.tpl.id] },
    });
    const reordered = res.json() as PromptTemplate[];
    expect(reordered.map((t) => t.title)).toEqual(['C', 'A', 'B']);
    expect(reordered.map((t) => t.orderIndex)).toEqual([0, 1, 2]);
  });

  it('rejects a reorder without an ids array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-templates/reorder',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps a dense, unique order on partial/duplicate/stale reorder input', async () => {
    const a = await create('A', 'a');
    const b = await create('B', 'b');
    const c = await create('C', 'c');
    // Partial list (only C) + a stale id + a duplicate. C goes first; the
    // omitted A,B keep their relative order and are appended; nothing collides.
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-templates/reorder',
      payload: { ids: ['ghost', c.tpl.id, c.tpl.id, a.tpl.id] },
    });
    const reordered = res.json() as PromptTemplate[];
    expect(reordered.map((t) => t.title)).toEqual(['C', 'A', 'B']);
    // dense + unique 0..n-1
    expect(reordered.map((t) => t.orderIndex)).toEqual([0, 1, 2]);
    expect(b.tpl.id).toBeTruthy();
  });
});
