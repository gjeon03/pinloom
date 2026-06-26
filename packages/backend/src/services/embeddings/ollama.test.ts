import { describe, expect, it, vi } from 'vitest';
import { OllamaEmbeddingProvider } from './ollama.js';

// A fake fetch returning canned embeddings shaped like Ollama's /api/embed.
function fakeFetch(vectors: number[][], opts: { ok?: boolean; status?: number; body?: unknown } = {}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { input: string[] };
    const embeddings = opts.body !== undefined ? undefined : vectors.slice(0, req.input.length);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => (opts.body !== undefined ? opts.body : { embeddings }),
      text: async () => 'error body',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('OllamaEmbeddingProvider', () => {
  it('embeds a query and discovers dim from the response', async () => {
    const p = new OllamaEmbeddingProvider({ model: 'bge-m3', fetchImpl: fakeFetch([[1, 2, 3, 4]]) });
    expect(p.id).toBe('ollama:bge-m3');
    expect(p.dim).toBe(0); // unknown until first embed
    const v = await p.embedQuery('hi');
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
    expect(p.dim).toBe(4);
  });

  it('batches embedPassages and sends model + input', async () => {
    const f = fakeFetch([[1, 0], [0, 1], [1, 1]]);
    const p = new OllamaEmbeddingProvider({ fetchImpl: f });
    const out = await p.embedPassages(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(Array.from(out[2])).toEqual([1, 1]);
    const body = JSON.parse(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body).toMatchObject({ model: 'bge-m3', input: ['a', 'b', 'c'] });
  });

  it('truncates oversized inputs to stay under the model context window', async () => {
    const f = fakeFetch([[1]]);
    const p = new OllamaEmbeddingProvider({ fetchImpl: f });
    await p.embedPassages(['x'.repeat(50_000)]);
    const body = JSON.parse(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.input[0]).toHaveLength(4000); // default cap
  });

  it('honors PINLOOM_OLLAMA_MAX_CHARS for the input cap', async () => {
    vi.stubEnv('PINLOOM_OLLAMA_MAX_CHARS', '10');
    const f = fakeFetch([[1]]);
    const p = new OllamaEmbeddingProvider({ fetchImpl: f });
    await p.embedPassages(['abcdefghijklmnop']);
    const body = JSON.parse(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.input[0]).toBe('abcdefghij');
    vi.unstubAllEnvs();
  });

  it('returns [] for an empty passage list without calling the server', async () => {
    const f = fakeFetch([]);
    const p = new OllamaEmbeddingProvider({ fetchImpl: f });
    expect(await p.embedPassages([])).toEqual([]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('throws on a non-ok response (so warmup degrades to FTS)', async () => {
    const p = new OllamaEmbeddingProvider({ fetchImpl: fakeFetch([], { ok: false, status: 404 }) });
    await expect(p.embedQuery('x')).rejects.toThrow(/ollama embed 404/);
  });

  it('throws when the response count does not match the inputs', async () => {
    const p = new OllamaEmbeddingProvider({ fetchImpl: fakeFetch([], { body: { embeddings: [[1, 2]] } }) });
    await expect(p.embedPassages(['a', 'b'])).rejects.toThrow(/expected 2 vectors/);
  });

  it('honors a custom model + baseUrl in the id and request URL', async () => {
    const f = fakeFetch([[1]]);
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text', baseUrl: 'http://x:1234/', fetchImpl: f });
    expect(p.id).toBe('ollama:nomic-embed-text');
    await p.embedQuery('q');
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://x:1234/api/embed');
  });
});
