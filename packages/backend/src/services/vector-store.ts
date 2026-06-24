// Vector store over the existing SQLite DB via the sqlite-vec extension. One
// vec0 virtual table per corpus source (Phase 1: `message_vectors`; wiki /
// timeline slot in later as their own tables behind this same generic helper —
// no rebuild of existing tables, docs/knowledge-system-v3.md §11 M5).
//
// All operations are GUARDED by isVectorAvailable(): when the extension didn't
// load, every call is a no-op / empty and the system runs on lexical FTS. The
// vec0 tables are created LAZILY here (never via the numbered-migration ledger,
// which would crash boot if the extension were absent — §11 H1).
//
// vec0 has NO UPSERT (spike-verified) → re-embed is delete+insert. Vectors bind
// as Float32Array (better-sqlite3 passes the buffer as a blob sqlite-vec reads).

import type { Database } from 'better-sqlite3';
import { isVectorAvailable } from '../db/connection.js';

// Table names are internal constants (never user input) → safe to interpolate.
export const MESSAGE_VECTORS = 'message_vectors';

/** Create the bookkeeping meta table only. Idempotent + dim-independent, so it
 *  is safe to call before reading meta on a fresh DB (the vec0 table needs a
 *  dim, but the meta read that decides the dim must not require the vec0 table). */
export function ensureMetaTable(db: Database): void {
  if (!isVectorAvailable()) return;
  db.exec(
    `CREATE TABLE IF NOT EXISTS vector_meta (
       table_name TEXT PRIMARY KEY,
       model_id   TEXT NOT NULL,
       dim        INTEGER NOT NULL
     )`,
  );
}

/** Create the bookkeeping meta table + a source's vec0 table at `dim` width.
 *  Idempotent. No-op when the extension is unavailable. */
export function ensureVectorTable(db: Database, table: string, dim: number): void {
  if (!isVectorAvailable()) return;
  ensureMetaTable(db);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
       doc_id TEXT PRIMARY KEY,
       embedding float[${dim}]
     )`,
  );
}

export interface VectorMeta {
  modelId: string;
  dim: number;
}

export function getVectorMeta(db: Database, table: string): VectorMeta | null {
  if (!isVectorAvailable()) return null;
  // Ensure the meta table exists first — on a fresh DB this read would otherwise
  // throw "no such table: vector_meta" before ensureVectorTable ever runs, which
  // wedged the indexer (it reads meta to decide the dim). See message-indexer.
  ensureMetaTable(db);
  const row = db
    .prepare('SELECT model_id, dim FROM vector_meta WHERE table_name = ?')
    .get(table) as { model_id: string; dim: number } | undefined;
  return row ? { modelId: row.model_id, dim: row.dim } : null;
}

export function setVectorMeta(
  db: Database,
  table: string,
  modelId: string,
  dim: number,
): void {
  if (!isVectorAvailable()) return;
  db.prepare(
    `INSERT INTO vector_meta (table_name, model_id, dim) VALUES (?, ?, ?)
     ON CONFLICT(table_name) DO UPDATE SET model_id = excluded.model_id, dim = excluded.dim`,
  ).run(table, modelId, dim);
}

/** Drop + recreate a source's vec table at a new width (model/dim change → the
 *  caller then re-embeds from scratch). Vectors are a derived index, so dropping
 *  is safe. */
export function rebuildVectorTable(db: Database, table: string, dim: number): void {
  if (!isVectorAvailable()) return;
  db.exec(`DROP TABLE IF EXISTS ${table}`);
  ensureVectorTable(db, table, dim);
}

/** Insert or replace one document's vector (delete+insert; vec0 has no upsert). */
export function upsertVector(
  db: Database,
  table: string,
  docId: string,
  embedding: Float32Array,
): void {
  if (!isVectorAvailable()) return;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(docId);
    db.prepare(`INSERT INTO ${table} (doc_id, embedding) VALUES (?, ?)`).run(
      docId,
      embedding,
    );
  });
  tx();
}

export function deleteVector(db: Database, table: string, docId: string): void {
  if (!isVectorAvailable()) return;
  db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(docId);
}

export interface VectorHit {
  docId: string;
  distance: number;
}

/** k-nearest neighbours for a query vector. Empty when unavailable. */
export function knn(
  db: Database,
  table: string,
  query: Float32Array,
  k: number,
): VectorHit[] {
  if (!isVectorAvailable()) return [];
  try {
    const rows = db
      .prepare(
        `SELECT doc_id, distance FROM ${table}
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(query, k) as { doc_id: string; distance: number }[];
    return rows.map((r) => ({ docId: r.doc_id, distance: r.distance }));
  } catch {
    // table not created yet (provider not warm) → degrade.
    return [];
  }
}

/** Evict vectors whose doc no longer exists. `validIdsSql` is a subquery
 *  returning the live ids (e.g. `SELECT id FROM messages`). Cheap GC that makes
 *  an explicit AFTER DELETE trigger unnecessary — a trigger would persist in the
 *  schema and break message deletes on any later boot where the extension fails
 *  to load. doc_ids are never reused (nanoid), so orphans are harmless until GC. */
export function gcOrphans(db: Database, table: string, validIdsSql: string): number {
  if (!isVectorAvailable()) return 0;
  try {
    const info = db
      .prepare(`DELETE FROM ${table} WHERE doc_id NOT IN (${validIdsSql})`)
      .run();
    return info.changes;
  } catch {
    return 0;
  }
}

export function vectorRowCount(db: Database, table: string): number {
  if (!isVectorAvailable()) return 0;
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } catch {
    return 0;
  }
}
