import { describe, it, expect } from 'vitest';
import { createScrollback } from './scrollback.js';

/** What the old inline implementation did, kept as the behavioral oracle. */
function naive(chunks: string[], limit: number): string {
  return chunks.reduce((acc, c) => (acc + c).slice(-limit), '');
}

describe('createScrollback', () => {
  it('is empty before anything is pushed', () => {
    expect(createScrollback(16).snapshot()).toBe('');
  });

  it('keeps everything while under the limit', () => {
    const sb = createScrollback(16);
    sb.push('abc');
    sb.push('def');
    expect(sb.snapshot()).toBe('abcdef');
  });

  it('ignores empty chunks', () => {
    const sb = createScrollback(16);
    sb.push('ab');
    sb.push('');
    expect(sb.snapshot()).toBe('ab');
  });

  it('keeps only the tail once past the limit', () => {
    const sb = createScrollback(4);
    for (const c of ['ab', 'cd', 'ef', 'gh']) sb.push(c);
    expect(sb.snapshot()).toBe('efgh');
  });

  it('trims a single chunk that alone exceeds the limit', () => {
    const sb = createScrollback(4);
    sb.push('abcdefghij');
    expect(sb.snapshot()).toBe('ghij');
  });

  it('caps multibyte output by UTF-8 bytes without splitting a character', () => {
    const sb = createScrollback(8);
    sb.push('가나다');

    expect(sb.snapshot()).toBe('나다');
    expect(Buffer.byteLength(sb.snapshot())).toBeLessThanOrEqual(8);
  });

  it('caps an oversized single chunk by UTF-8 bytes', () => {
    const sb = createScrollback(8);
    sb.push('abc😀가나다');

    expect(sb.snapshot()).toBe('나다');
    expect(Buffer.byteLength(sb.snapshot())).toBeLessThanOrEqual(8);
  });

  it('continues retaining only the newest chunks across many full evictions', () => {
    const sb = createScrollback(8);
    for (let i = 0; i < 1000; i++) sb.push(`${i}`.padStart(8, '0'));

    expect(sb.snapshot()).toBe('00000999');
  });

  it('preserves the tail after a partial eviction of an unaligned chunk', () => {
    const sb = createScrollback(10);
    sb.push('abcdefg');
    sb.push('한글');

    expect(sb.snapshot()).toBe('defg한글');
    expect(Buffer.byteLength(sb.snapshot())).toBe(10);
  });

  it('is stable across repeated snapshots', () => {
    const sb = createScrollback(4);
    sb.push('abcdef');
    expect(sb.snapshot()).toBe('cdef');
    expect(sb.snapshot()).toBe('cdef');
    sb.push('gh');
    expect(sb.snapshot()).toBe('efgh');
  });

  it('matches the naive concat+slice for many small chunks', () => {
    const limit = 64;
    const chunks = Array.from({ length: 500 }, (_, i) => `${i % 10}`.repeat((i % 7) + 1));
    const sb = createScrollback(limit);
    for (const c of chunks) sb.push(c);
    expect(sb.snapshot()).toBe(naive(chunks, limit));
  });

  it('matches the naive concat+slice when snapshotting mid-stream', () => {
    const limit = 32;
    const chunks = Array.from({ length: 200 }, (_, i) => `<${i}>`);
    const sb = createScrollback(limit);
    chunks.forEach((c, i) => {
      sb.push(c);
      // Interleaved snapshots must not disturb later accumulation.
      if (i % 5 === 0) expect(sb.snapshot()).toBe(naive(chunks.slice(0, i + 1), limit));
    });
    expect(sb.snapshot()).toBe(naive(chunks, limit));
  });
});
