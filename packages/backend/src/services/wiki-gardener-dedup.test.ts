import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, isVectorAvailable } from '../db/connection.js';
import { ensureVectorTable, setVectorMeta, upsertVector } from './vector-store.js';
import { WIKI_VECTORS } from './wiki-indexer.js';
import { findDuplicateCandidates, runGardener, type RunAgent } from './wiki-gardener.js';

const available = isVectorAvailable();
const db = getDb();

describe.skipIf(!available)('findDuplicateCandidates', () => {
  beforeEach(() => {
    db.exec(`DROP TABLE IF EXISTS ${WIKI_VECTORS};`);
    try {
      db.exec(`DELETE FROM vector_meta WHERE table_name='${WIKI_VECTORS}';`);
    } catch {
      // meta table may not exist yet
    }
    ensureVectorTable(db, WIKI_VECTORS, 3);
    setVectorMeta(db, WIKI_VECTORS, 'fake', 3);
  });

  it('surfaces near-duplicate pairs above threshold, skips distinct pages', () => {
    upsertVector(db, WIKI_VECTORS, 'a.md', new Float32Array([1, 0.01, 0]));
    upsertVector(db, WIKI_VECTORS, 'b.md', new Float32Array([1, 0, 0.01])); // ~dup of a
    upsertVector(db, WIKI_VECTORS, 'c.md', new Float32Array([0, 1, 0])); // orthogonal
    const cands = findDuplicateCandidates(db, { threshold: 0.86 });
    expect(cands).toHaveLength(1);
    expect([cands[0].a, cands[0].b].sort()).toEqual(['a.md', 'b.md']);
    expect(cands[0].sim).toBeGreaterThan(0.86);
  });

  it('returns the strongest pairs first and respects the limit', () => {
    upsertVector(db, WIKI_VECTORS, 'a.md', new Float32Array([1, 0, 0]));
    upsertVector(db, WIKI_VECTORS, 'b.md', new Float32Array([1, 0.001, 0])); // strongest
    upsertVector(db, WIKI_VECTORS, 'c.md', new Float32Array([1, 0.1, 0])); // weaker but > thr
    const cands = findDuplicateCandidates(db, { threshold: 0.9, limit: 1 });
    expect(cands).toHaveLength(1);
    expect([cands[0].a, cands[0].b].sort()).toEqual(['a.md', 'b.md']);
  });

  it('is empty when nothing is near-duplicate', () => {
    upsertVector(db, WIKI_VECTORS, 'a.md', new Float32Array([1, 0, 0]));
    upsertVector(db, WIKI_VECTORS, 'c.md', new Float32Array([0, 1, 0]));
    expect(findDuplicateCandidates(db, { threshold: 0.86 })).toEqual([]);
  });
});

describe('runGardener duplicate-hint injection', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-gardener-hints-'));
    await mkdir(path.join(root, 'pages'), { recursive: true });
    await writeFile(path.join(root, 'pages', 'a.md'), '# A\nalpha', 'utf8');
    await writeFile(path.join(root, 'pages', 'b.md'), '# B\nbeta', 'utf8');
    db.exec('DELETE FROM wiki_proposals;');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prepends the duplicate-pairs block to the gardener prompt', async () => {
    let seenPrompt = '';
    const capture: RunAgent = async (prompt) => {
      seenPrompt = prompt;
      return '[]';
    };
    await runGardener({
      root,
      runAgent: capture,
      now: '2026-06-22T00:00:00.000Z',
      duplicateHints: [{ a: 'a.md', b: 'b.md', sim: 0.93 }],
    });
    expect(seenPrompt).toContain('Likely duplicate pairs');
    expect(seenPrompt).toContain('`a.md` ↔ `b.md`');
    expect(seenPrompt).toContain('0.93');
  });

  it('adds no hint block when there are no candidates', async () => {
    let seenPrompt = '';
    const capture: RunAgent = async (prompt) => {
      seenPrompt = prompt;
      return '[]';
    };
    await runGardener({ root, runAgent: capture, now: '2026-06-22T00:00:00.000Z' });
    expect(seenPrompt).not.toContain('Likely duplicate pairs');
  });
});
