import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserEnvVar, UserEnvVarWithValue } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { settingsRoutes } from './settings.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(settingsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// Tests touch process.env to verify the live-sync side effect. Snapshot any
// keys we mutate so the suite can't bleed real env vars into other tests.
const TEST_KEYS = ['ASANA_TOKEN', 'GITLAB_TOKEN', 'NOTION_TOKEN', 'API_BASE_URL'];
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  getDb().exec('DELETE FROM user_env;');
  for (const k of TEST_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function put(key: string, body: unknown) {
  return app.inject({ method: 'PUT', url: `/api/settings/env/${key}`, payload: body });
}

describe('PUT /api/settings/env/:key — validation', () => {
  it('rejects keys with invalid characters', async () => {
    const res = await put('NOT VALID', { value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid key/);
  });

  it('rejects keys starting with a digit', async () => {
    const res = await put('1ASANA', { value: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts uppercase, lowercase, digits, and underscores', async () => {
    const res = await put('My_Token_2', { value: 'x' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an empty value', async () => {
    const res = await put('ASANA_TOKEN', { value: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty/);
  });

  it('rejects when the value is missing', async () => {
    const res = await put('ASANA_TOKEN', {});
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/settings/env/:key — upsert', () => {
  it('inserts a new key and mirrors it into process.env', async () => {
    const res = await put('ASANA_TOKEN', {
      value: 'secret-asana',
      description: 'Asana PAT',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UserEnvVar;
    expect(body.key).toBe('ASANA_TOKEN');
    expect(body.description).toBe('Asana PAT');
    expect(body.isSecret).toBe(true);
    expect(body.hasValue).toBe(true);
    expect(process.env.ASANA_TOKEN).toBe('secret-asana');
  });

  it('updates an existing key and reflects the new value in process.env', async () => {
    await put('ASANA_TOKEN', { value: 'first' });
    expect(process.env.ASANA_TOKEN).toBe('first');

    const res = await put('ASANA_TOKEN', { value: 'second' });
    expect(res.statusCode).toBe(200);
    expect(process.env.ASANA_TOKEN).toBe('second');
  });

  it('preserves created_at across updates', async () => {
    const r1 = await put('ASANA_TOKEN', { value: 'a' });
    const created = (r1.json() as UserEnvVar).createdAt;
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await put('ASANA_TOKEN', { value: 'b' });
    const after = r2.json() as UserEnvVar;
    expect(after.createdAt).toBe(created);
    expect(after.updatedAt >= created).toBe(true);
  });

  it('honors isSecret=false', async () => {
    const res = await put('API_BASE_URL', {
      value: 'https://api.example.com',
      isSecret: false,
    });
    expect((res.json() as UserEnvVar).isSecret).toBe(false);
  });
});

describe('GET /api/settings/env', () => {
  it('returns an empty list when nothing is set', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/env' });
    expect(res.json()).toEqual([]);
  });

  it('lists keys without exposing the value field', async () => {
    await put('ASANA_TOKEN', { value: 'asana-secret', description: 'A' });
    await put('GITLAB_TOKEN', { value: 'gitlab-secret' });

    const res = await app.inject({ method: 'GET', url: '/api/settings/env' });
    const body = res.json() as UserEnvVar[];
    expect(body).toHaveLength(2);
    // The list shape must not carry raw values.
    expect(body[0]).not.toHaveProperty('value');
    expect(body[1]).not.toHaveProperty('value');
    // Sorted by key ASC.
    expect(body.map((v) => v.key)).toEqual(['ASANA_TOKEN', 'GITLAB_TOKEN']);
  });
});

describe('GET /api/settings/env/:key', () => {
  it('returns the value field on the single-item endpoint', async () => {
    await put('ASANA_TOKEN', { value: 'plaintext-here' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/env/ASANA_TOKEN',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as UserEnvVarWithValue).value).toBe('plaintext-here');
  });

  it('returns 404 for an unknown key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/env/NOPE',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/settings/env/:key', () => {
  it('removes the key from the DB and from process.env', async () => {
    await put('ASANA_TOKEN', { value: 'to-be-deleted' });
    expect(process.env.ASANA_TOKEN).toBe('to-be-deleted');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/settings/env/ASANA_TOKEN',
    });
    expect(res.statusCode).toBe(200);
    expect(process.env.ASANA_TOKEN).toBeUndefined();

    const list = await app.inject({ method: 'GET', url: '/api/settings/env' });
    expect(list.json()).toEqual([]);
  });

  it('returns 404 when deleting a key that does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/settings/env/NOPE',
    });
    expect(res.statusCode).toBe(404);
  });
});
