import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, isVectorAvailable } from '../db/connection.js';
import {
  MESSAGE_VECTORS,
  ensureVectorTable,
  gcOrphans,
  getVectorMeta,
  knn,
  rebuildVectorTable,
  setVectorMeta,
  upsertVector,
  vectorRowCount,
} from './vector-store.js';

// getDb() opens the per-fork temp DB and loads sqlite-vec. If the extension
// can't load in this environment, the whole suite degrades — skip rather than
// fail (search would just run on FTS).
const db = getDb();
const available = isVectorAvailable();
const v = (a: number[]) => new Float32Array(a);

describe.skipIf(!available)('vector-store', () => {
  beforeAll(() => {
    ensureVectorTable(db, MESSAGE_VECTORS, 3);
  });

  it('upsert + knn returns the nearest doc', () => {
    upsertVector(db, MESSAGE_VECTORS, 'near', v([1, 0, 0]));
    upsertVector(db, MESSAGE_VECTORS, 'far', v([0, 0, 1]));
    const hits = knn(db, MESSAGE_VECTORS, v([0.95, 0.05, 0]), 2);
    expect(hits[0].docId).toBe('near');
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it('upsert replaces in place (vec0 has no UPSERT → delete+insert)', () => {
    upsertVector(db, MESSAGE_VECTORS, 'near', v([0, 1, 0]));
    // 'near' now matches [0,1,0], and there is still exactly one 'near' row
    const hits = knn(db, MESSAGE_VECTORS, v([0, 1, 0]), 1);
    expect(hits[0].docId).toBe('near');
    const rows = db
      .prepare(`SELECT COUNT(*) c FROM ${MESSAGE_VECTORS} WHERE doc_id = 'near'`)
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('tracks model/dim meta', () => {
    setVectorMeta(db, MESSAGE_VECTORS, 'inproc:multilingual-e5-small', 3);
    expect(getVectorMeta(db, MESSAGE_VECTORS)).toEqual({
      modelId: 'inproc:multilingual-e5-small',
      dim: 3,
    });
  });

  it('rebuild drops all vectors (for a model/dim switch)', () => {
    expect(vectorRowCount(db, MESSAGE_VECTORS)).toBeGreaterThan(0);
    rebuildVectorTable(db, MESSAGE_VECTORS, 3);
    expect(vectorRowCount(db, MESSAGE_VECTORS)).toBe(0);
  });

  it('gcOrphans evicts vectors whose message no longer exists', () => {
    db.prepare(
      "INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('vp','VP','/tmp/vp','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES ('vs','vp','S','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,created_at) VALUES ('live','vs','user','hi','t')",
    ).run();
    upsertVector(db, MESSAGE_VECTORS, 'live', v([1, 0, 0])); // has a message
    upsertVector(db, MESSAGE_VECTORS, 'ghost', v([0, 1, 0])); // orphan
    const removed = gcOrphans(db, MESSAGE_VECTORS, 'SELECT id FROM messages');
    expect(removed).toBe(1);
    const ids = db
      .prepare(`SELECT doc_id FROM ${MESSAGE_VECTORS} ORDER BY doc_id`)
      .all()
      .map((r) => (r as { doc_id: string }).doc_id);
    expect(ids).toEqual(['live']);
  });
});
