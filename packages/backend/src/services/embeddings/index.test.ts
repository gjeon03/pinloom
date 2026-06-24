import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEmbeddingsForTest,
  embeddingsReady,
  getEmbeddingProvider,
  initEmbeddings,
} from './index.js';
import type { EmbeddingProvider } from './types.js';

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: 'fake',
    dim: 4,
    embedQuery: async () => new Float32Array(4),
    embedPassages: async (t) => t.map(() => new Float32Array(4)),
    ...overrides,
  };
}

// Let the floating warmup promise settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  __resetEmbeddingsForTest();
  delete process.env.PINLOOM_EMBEDDINGS;
  vi.restoreAllMocks();
});

describe('embeddings manager', () => {
  it('is null/not-ready before init', () => {
    expect(getEmbeddingProvider()).toBeNull();
    expect(embeddingsReady()).toBe(false);
  });

  it('becomes ready and serves the provider after a successful warmup', async () => {
    const p = fakeProvider();
    initEmbeddings(p);
    expect(embeddingsReady()).toBe(false); // warmup is async
    await flush();
    expect(embeddingsReady()).toBe(true);
    expect(getEmbeddingProvider()).toBe(p);
  });

  it('stays FTS-only (null) when PINLOOM_EMBEDDINGS=off', async () => {
    process.env.PINLOOM_EMBEDDINGS = 'off';
    initEmbeddings(fakeProvider());
    await flush();
    expect(embeddingsReady()).toBe(false);
    expect(getEmbeddingProvider()).toBeNull();
  });

  it('degrades (null, no throw) when warmup fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    initEmbeddings(
      fakeProvider({
        embedQuery: async () => {
          throw new Error('offline');
        },
      }),
    );
    await flush();
    expect(embeddingsReady()).toBe(false);
    expect(getEmbeddingProvider()).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('init is idempotent', async () => {
    const p1 = fakeProvider({ id: 'p1' });
    const p2 = fakeProvider({ id: 'p2' });
    initEmbeddings(p1);
    initEmbeddings(p2); // ignored
    await flush();
    expect(getEmbeddingProvider()?.id).toBe('p1');
  });
});
