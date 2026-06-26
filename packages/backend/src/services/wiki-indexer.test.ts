import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, isVectorAvailable } from '../db/connection.js';
import { vectorRowCount } from './vector-store.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import {
  WIKI_VECTORS,
  __resetWikiIndexerForTest,
  gcWikiVectors,
  runWikiIndexPass,
  wikiTitle,
} from './wiki-indexer.js';

const db = getDb();
const available = isVectorAvailable();
const fakeProvider: EmbeddingProvider = {
  id: 'fake',
  dim: 4,
  embedQuery: async () => new Float32Array(4),
  embedPassages: async (t) => t.map(() => new Float32Array(4)),
};

let home: string;
async function writePage(slug: string, content: string) {
  const dir = path.join(home, '.pinloom', 'wiki', 'pages');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), content);
}

describe('wikiTitle', () => {
  it('prefers the first heading, then summary, then slug', () => {
    expect(wikiTitle('---\nsummary: "S"\n---\n# Real Title\n\nbody', 'slug')).toBe('Real Title');
    expect(wikiTitle('---\nsummary: "Sum here"\n---\n\nbody', 'slug')).toBe('Sum here');
    expect(wikiTitle('just body no heading', 'the-slug')).toBe('the-slug');
  });
});

describe.skipIf(!available)('wiki-indexer', () => {
  beforeEach(async () => {
    db.exec(`DELETE FROM wiki_index_state; DROP TABLE IF EXISTS ${WIKI_VECTORS};`);
    try {
      db.exec(`DELETE FROM vector_meta WHERE table_name='${WIKI_VECTORS}';`);
    } catch {
      // meta table not created yet
    }
    __resetWikiIndexerForTest();
    home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-wkidx-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('indexes wiki pages → vector + state keyed by slug', async () => {
    await writePage('conventions-kso', '# Conventions\n\nuse pnpm + strict TS');
    await writePage('msw-setup-kso', '# MSW\n\nmock service worker setup');
    const r = await runWikiIndexPass(db, fakeProvider, home);
    expect(r.processed).toBe(2);
    expect(vectorRowCount(db, WIKI_VECTORS)).toBe(2);
    const ids = db
      .prepare('SELECT doc_id FROM wiki_index_state ORDER BY doc_id')
      .all()
      .map((x) => (x as { doc_id: string }).doc_id);
    expect(ids).toEqual(['conventions-kso', 'msw-setup-kso']);
  });

  it('skips unchanged, re-embeds on change, ignores whitespace-only edits', async () => {
    await writePage('p', 'hello   world');
    expect((await runWikiIndexPass(db, fakeProvider, home)).processed).toBe(1);
    expect((await runWikiIndexPass(db, fakeProvider, home)).processed).toBe(0); // unchanged
    await writePage('p', '  hello world\n'); // whitespace-only
    expect((await runWikiIndexPass(db, fakeProvider, home)).processed).toBe(0);
    await writePage('p', 'completely different content now');
    expect((await runWikiIndexPass(db, fakeProvider, home)).processed).toBe(1);
  });

  it('GC evicts a deleted page; no-op on failed walk / missing root', async () => {
    await writePage('keep', 'keep me');
    await writePage('gone', 'delete me');
    await runWikiIndexPass(db, fakeProvider, home);
    expect(vectorRowCount(db, WIKI_VECTORS)).toBe(2);
    rmSync(path.join(home, '.pinloom', 'wiki', 'pages', 'gone.md'));
    const r = await runWikiIndexPass(db, fakeProvider, home);
    expect(gcWikiVectors(db, r)).toBe(1);
    expect(vectorRowCount(db, WIKI_VECTORS)).toBe(1);
    // safety: bad walk / missing root never wipes
    expect(gcWikiVectors(db, { processed: 0, validDocIds: new Set(), walkOk: false, rootExists: true })).toBe(0);
    expect(gcWikiVectors(db, { processed: 0, validDocIds: new Set(), walkOk: true, rootExists: false })).toBe(0);
    expect(vectorRowCount(db, WIKI_VECTORS)).toBe(1);
  });

  it('skips empty pages', async () => {
    await writePage('blank', '   \n  ');
    const r = await runWikiIndexPass(db, fakeProvider, home);
    expect(r.processed).toBe(0);
    expect(vectorRowCount(db, WIKI_VECTORS)).toBe(0);
  });
});
