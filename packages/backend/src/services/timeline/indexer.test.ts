import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, isVectorAvailable } from '../../db/connection.js';
import { getProjectWikiSlugByProjectId } from '../wiki-sync.js';
import { vectorRowCount } from '../vector-store.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { writeEntry } from './store.js';
import {
  TIMELINE_VECTORS,
  __resetTimelineIndexerForTest,
  gcTimelineVectors,
  runTimelineIndexPass,
} from './indexer.js';
import fs from 'node:fs';

const db = getDb();
const available = isVectorAvailable();

const fakeProvider: EmbeddingProvider = {
  id: 'fake',
  dim: 4,
  embedQuery: async () => new Float32Array(4),
  embedPassages: async (texts) => texts.map(() => new Float32Array(4)),
};

let home: string;
function seedProject(id: string, cwd: string) {
  db.prepare(
    'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run(id, id.toUpperCase(), cwd, 't', 't');
}
const slugOf = (id: string) => getProjectWikiSlugByProjectId(id);

describe.skipIf(!available)('timeline-indexer', () => {
  beforeEach(async () => {
    db.exec(`DELETE FROM projects; DELETE FROM timeline_index_state; DROP TABLE IF EXISTS ${TIMELINE_VECTORS};`);
    try {
      db.exec(`DELETE FROM vector_meta WHERE table_name='${TIMELINE_VECTORS}';`);
    } catch {
      // vector_meta not created yet on the very first run
    }
    __resetTimelineIndexerForTest();
    home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-tlidx-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('indexes an entry → vector + state, keyed by projectId:date', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', '# day\n\n## What\n- built the indexer', home);
    const r = await runTimelineIndexPass(db, fakeProvider, home);
    expect(r.processed).toBe(1);
    expect(r.walkOk).toBe(true);
    expect(vectorRowCount(db, TIMELINE_VECTORS)).toBe(1);
    const st = db
      .prepare('SELECT doc_id FROM timeline_index_state')
      .all()
      .map((x) => (x as { doc_id: string }).doc_id);
    expect(st).toEqual(['p1:2026-06-24']); // durable projectId key, not slug
  });

  it('skips an unchanged entry on the next pass (hash match)', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', 'same content here', home);
    expect((await runTimelineIndexPass(db, fakeProvider, home)).processed).toBe(1);
    expect((await runTimelineIndexPass(db, fakeProvider, home)).processed).toBe(0);
  });

  it('re-embeds when the entry content changes', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', 'first version', home);
    await runTimelineIndexPass(db, fakeProvider, home);
    writeEntry(slugOf('p1'), '2026-06-24', 'a meaningfully different second version', home);
    expect((await runTimelineIndexPass(db, fakeProvider, home)).processed).toBe(1);
  });

  it('whitespace-only changes do NOT re-embed (normalized hash)', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', 'hello   world', home);
    await runTimelineIndexPass(db, fakeProvider, home);
    writeEntry(slugOf('p1'), '2026-06-24', '  hello world\n', home);
    expect((await runTimelineIndexPass(db, fakeProvider, home)).processed).toBe(0);
  });

  it('GC evicts the vector + state when the entry file is gone', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', 'to be deleted', home);
    await runTimelineIndexPass(db, fakeProvider, home);
    fs.rmSync(path.join(home, '.pinloom', 'timeline', slugOf('p1'), '2026-06-24.md'));
    const r = await runTimelineIndexPass(db, fakeProvider, home);
    expect(gcTimelineVectors(db, r)).toBe(1);
    expect(vectorRowCount(db, TIMELINE_VECTORS)).toBe(0);
  });

  it('GC is a no-op on a failed walk or a missing root (no mass-delete)', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', 'keep me', home);
    await runTimelineIndexPass(db, fakeProvider, home);
    const valid = new Set(['p1:2026-06-24']);
    // failed walk → never trust the valid set
    expect(gcTimelineVectors(db, { processed: 0, validDocIds: valid, walkOk: false, rootExists: true })).toBe(0);
    // root gone (e.g. home unmounted) → an empty set would otherwise wipe everything
    expect(gcTimelineVectors(db, { processed: 0, validDocIds: new Set(), walkOk: true, rootExists: false })).toBe(0);
    expect(vectorRowCount(db, TIMELINE_VECTORS)).toBe(1); // still there
  });

  it('skips empty entries', async () => {
    seedProject('p1', '/tmp/alpha');
    writeEntry(slugOf('p1'), '2026-06-24', '   \n  ', home);
    const r = await runTimelineIndexPass(db, fakeProvider, home);
    expect(r.processed).toBe(0);
    expect(vectorRowCount(db, TIMELINE_VECTORS)).toBe(0);
  });
});
