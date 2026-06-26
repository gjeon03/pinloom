import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPullForTest,
  hasModel,
  ollamaStatus,
  pullStatus,
  startPull,
} from './ollama-admin.js';

afterEach(() => __resetPullForTest());

function jsonResp(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

// A fake streaming Response body that yields the given NDJSON lines.
function streamResp(lines: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < lines.length
            ? { value: enc.encode(lines[i++] + '\n'), done: false }
            : { value: undefined, done: true },
      }),
    },
  } as unknown as Response;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function untilDone(timeout = 1000) {
  const start = Date.now();
  while (pullStatus().pulling && Date.now() - start < timeout) await wait(10);
}

describe('ollamaStatus / hasModel', () => {
  it('reports running + models when /api/tags responds', async () => {
    const f = vi.fn(async () => jsonResp({ models: [{ name: 'bge-m3:latest' }, { name: 'llama3:8b' }] }));
    const s = await ollamaStatus(f as unknown as typeof fetch);
    expect(s).toEqual({ running: true, models: ['bge-m3:latest', 'llama3:8b'] });
    expect(hasModel(s, 'bge-m3')).toBe(true); // bare name matches :latest
    expect(hasModel(s, 'nomic-embed-text')).toBe(false);
  });

  it('reports not-running when the fetch throws (server down)', async () => {
    const f = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await ollamaStatus(f as unknown as typeof fetch)).toEqual({ running: false, models: [] });
  });
});

describe('startPull', () => {
  it('streams NDJSON progress into the job and finishes done', async () => {
    const f = vi.fn(async () =>
      streamResp([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', completed: 50, total: 100 }),
        JSON.stringify({ status: 'success', completed: 100, total: 100 }),
      ]),
    );
    expect(startPull('bge-m3', f as unknown as typeof fetch)).toBe(true);
    await untilDone();
    const j = pullStatus();
    expect(j.done).toBe(true);
    expect(j.error).toBeNull();
    expect(j.completed).toBe(100);
    expect(j.total).toBe(100);
  });

  it('refuses a second concurrent pull', async () => {
    const f = vi.fn(async () => streamResp([JSON.stringify({ status: 'downloading', completed: 1, total: 9 })]));
    expect(startPull('bge-m3', f as unknown as typeof fetch)).toBe(true);
    expect(startPull('nomic', f as unknown as typeof fetch)).toBe(false); // already running
    await untilDone();
  });

  it('captures a pull error from the stream', async () => {
    const f = vi.fn(async () => streamResp([JSON.stringify({ error: 'model not found' })]));
    startPull('nope', f as unknown as typeof fetch);
    await untilDone();
    expect(pullStatus().error).toBe('model not found');
    expect(pullStatus().done).toBe(false);
  });
});
