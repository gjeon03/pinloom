import { describe, expect, it } from 'vitest';
import { InProcessEmbeddingProvider, type RawEmbed } from './in-process.js';

// Records the exact text passed to the model so we can assert the e5 prefixes
// and length cap without loading the real ~120MB model.
function recorder() {
  const seen: string[] = [];
  const raw: RawEmbed = async (text) => {
    seen.push(text);
    return new Float32Array(384);
  };
  return { seen, raw };
}

describe('InProcessEmbeddingProvider', () => {
  it('exposes a stable id and dim', () => {
    const p = new InProcessEmbeddingProvider(async () => new Float32Array(384));
    expect(p.id).toBe('inproc:multilingual-e5-small');
    expect(p.dim).toBe(384);
  });

  it('prefixes queries with "query:"', async () => {
    const { seen, raw } = recorder();
    const p = new InProcessEmbeddingProvider(raw);
    const v = await p.embedQuery('빌링 마이그레이션');
    expect(v).toBeInstanceOf(Float32Array);
    expect(seen).toEqual(['query: 빌링 마이그레이션']);
  });

  it('prefixes passages with "passage:" (asymmetric from queries)', async () => {
    const { seen, raw } = recorder();
    const p = new InProcessEmbeddingProvider(raw);
    const out = await p.embedPassages(['결제 분리', 'UI 테마']);
    expect(out).toHaveLength(2);
    expect(seen).toEqual(['passage: 결제 분리', 'passage: UI 테마']);
  });

  it('returns [] for no passages without touching the model', async () => {
    const { seen, raw } = recorder();
    const p = new InProcessEmbeddingProvider(raw);
    expect(await p.embedPassages([])).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('caps very long text before embedding', async () => {
    const { seen, raw } = recorder();
    const p = new InProcessEmbeddingProvider(raw);
    await p.embedQuery('x'.repeat(5000));
    // "query: " prefix + 2000 capped chars
    expect(seen[0].startsWith('query: ')).toBe(true);
    expect(seen[0].length).toBe('query: '.length + 2000);
  });
});
