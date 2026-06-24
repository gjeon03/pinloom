import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, isVectorAvailable } from '../db/connection.js';
import {
  rrfFuse,
  searchMessages,
  searchMessagesHybrid,
} from './message-search.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { MESSAGE_VECTORS, ensureVectorTable, upsertVector } from './vector-store.js';

const db = getDb();
const available = isVectorAvailable();
const v = (a: number[]) => new Float32Array(a);

// Query vectors are keyed by raw query text so each case targets a region.
const queryVecs: Record<string, Float32Array> = {
  billing: v([0.98, 0.2, 0, 0]), // near m1 (billing) + m2 (payment)
  배포: v([0, 0, 0.1, 0.99]), // near m5 (릴리즈) + m4 (배포)
};
const fakeProvider: EmbeddingProvider = {
  id: 'fake',
  dim: 4,
  embedQuery: async (text) => queryVecs[text] ?? v([0, 0, 0, 0]),
  embedPassages: async (t) => t.map(() => v([0, 0, 0, 0])),
};

describe('rrfFuse', () => {
  it('ranks a doc appearing high in both lists first', () => {
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);
    // 'a' (ranks 0,1) and 'b' (ranks 1,0) score highest; both before c/d.
    expect(fused.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(fused).toContain('c');
    expect(fused).toContain('d');
  });
});

describe.skipIf(!available)('searchMessagesHybrid', () => {
  beforeAll(() => {
    ensureVectorTable(db, MESSAGE_VECTORS, 4);
    db.prepare(
      "INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('hp','HP','/tmp/hp','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES ('hs','hp','S','t','t')",
    ).run();
    const ins = db.prepare(
      'INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)',
    );
    ins.run('m1', 'hs', 'user', 'billing migration plan', '1');
    ins.run('m2', 'hs', 'assistant', 'payment routing question', '2'); // no "billing"
    ins.run('m3', 'hs', 'user', 'ui dark theme tokens', '3');
    ins.run('m4', 'hs', 'user', '오늘 배포 완료했다', '4');
    ins.run('m5', 'hs', 'assistant', '릴리즈 준비 작업', '5'); // no "배포"
    upsertVector(db, MESSAGE_VECTORS, 'm1', v([1, 0, 0, 0]));
    upsertVector(db, MESSAGE_VECTORS, 'm2', v([0.95, 0.31, 0, 0]));
    upsertVector(db, MESSAGE_VECTORS, 'm3', v([0, 0, 1, 0]));
    upsertVector(db, MESSAGE_VECTORS, 'm4', v([0, 0, 0, 1]));
    upsertVector(db, MESSAGE_VECTORS, 'm5', v([0, 0, 0.2, 0.98]));
  });

  it('degrades to exactly the FTS result when no provider', async () => {
    const fts = searchMessages(db, 'billing', {});
    const hybrid = await searchMessagesHybrid(db, 'billing', {}, null);
    expect(hybrid.map((r) => r.messageId)).toEqual(fts.map((r) => r.messageId));
    // FTS alone only finds the literal "billing" message
    expect(fts.map((r) => r.messageId)).toEqual(['m1']);
  });

  it('adds a semantically-related hit the keyword query misses (RRF ranking)', async () => {
    const ids = (await searchMessagesHybrid(db, 'billing', {}, fakeProvider)).map(
      (r) => r.messageId,
    );
    // m1 (keyword + semantic) ranks first; m2 (semantic only, no "billing"
    // substring) is surfaced near the top — ahead of the unrelated m3.
    // (Small corpus → KNN returns everything; the WIN is the ranking.)
    expect(ids[0]).toBe('m1');
    expect(ids.slice(0, 2)).toContain('m2');
    expect(ids.indexOf('m2')).toBeLessThan(ids.indexOf('m3'));
  });

  it('short-Korean query uses the semantic ranking (M1: no RRF on LIKE)', async () => {
    const ids = (await searchMessagesHybrid(db, '배포', {}, fakeProvider)).map(
      (r) => r.messageId,
    );
    // semantic hit that lacks the literal "배포" is surfaced
    expect(ids).toContain('m5');
  });
});
