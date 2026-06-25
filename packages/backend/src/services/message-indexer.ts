// Message indexer — keeps `message_vectors` populated from the messages table.
//
// Design choice: a periodic background SWEEP, not a hook on the live write path.
// This unifies backfill and "live" indexing into one cursor-based mechanism that
// is idempotent, resumable across restarts, and never touches the runner's hot
// path (no event-loop risk on a chat turn). New messages become searchable on
// the next sweep (a few seconds' lag — fine for searching history). The cursor
// `content <> '' AND id NOT IN (message_vectors)` naturally skips the empty
// streaming placeholder (indexed only once content lands) and never re-embeds.
//
// Everything is gated on a ready provider + the vec extension; otherwise it's a
// no-op and search runs on FTS.

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { getEmbeddingProvider } from './embeddings/index.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import {
  MESSAGE_VECTORS,
  ensureVectorTable,
  gcOrphans,
  getVectorMeta,
  rebuildVectorTable,
  setVectorMeta,
  upsertVector,
} from './vector-store.js';
import {
  __resetTimelineIndexerForTest,
  gcTimelineVectors,
  runTimelineIndexPass,
} from './timeline/indexer.js';

const BATCH = 32;
const INTERVAL_MS = 5000;
const nextTick = () => new Promise<void>((r) => setImmediate(r));

// Pending = content-bearing user/assistant rows (mirrors the FTS predicate),
// not already embedded. source_message_id IS NULL skips worker-mirror rows.
const PENDING_SQL = `
  SELECT id, content FROM messages
  WHERE role IN ('user','assistant') AND content <> '' AND source_message_id IS NULL
    AND id NOT IN (SELECT doc_id FROM ${MESSAGE_VECTORS})
  ORDER BY created_at ASC
  LIMIT ?`;

// Create the vec table on first run; on a model/dim change (e.g. switching to
// Ollama bge-m3 at 1024) drop + re-embed. Surfaced via log, not silent.
function ensureSchema(db: Database, provider: EmbeddingProvider): void {
  const meta = getVectorMeta(db, MESSAGE_VECTORS);
  if (!meta) {
    ensureVectorTable(db, MESSAGE_VECTORS, provider.dim);
    setVectorMeta(db, MESSAGE_VECTORS, provider.id, provider.dim);
    return;
  }
  if (meta.modelId !== provider.id || meta.dim !== provider.dim) {
    // eslint-disable-next-line no-console
    console.error(
      `[vector] embedding model changed (${meta.modelId} → ${provider.id}); rebuilding + re-embedding`,
    );
    rebuildVectorTable(db, MESSAGE_VECTORS, provider.dim);
    setVectorMeta(db, MESSAGE_VECTORS, provider.id, provider.dim);
  }
}

/** Embed + store one batch. Returns the count processed (0 = nothing pending). */
export async function indexOneBatch(
  db: Database,
  provider: EmbeddingProvider,
  limit = BATCH,
): Promise<number> {
  const rows = db.prepare(PENDING_SQL).all(limit) as { id: string; content: string }[];
  if (rows.length === 0) return 0;
  const vecs = await provider.embedPassages(rows.map((r) => r.content));
  const writeBatch = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      upsertVector(db, MESSAGE_VECTORS, rows[i].id, vecs[i]);
    }
  });
  writeBatch();
  return rows.length;
}

/** Drain all pending rows in batches, yielding to live traffic between each. */
export async function runIndexPass(
  db: Database,
  provider: EmbeddingProvider,
): Promise<number> {
  let total = 0;
  let n = 0;
  do {
    n = await indexOneBatch(db, provider);
    total += n;
    if (n > 0) await nextTick();
  } while (n === BATCH);
  return total;
}

let running = false;
let schemaReady = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (running) return; // single-flight
  const provider = getEmbeddingProvider();
  if (!provider) return; // not warm / FTS-only
  running = true;
  try {
    const db = getDb();
    if (!schemaReady) {
      ensureSchema(db, provider);
      schemaReady = true;
    }
    const processed = await runIndexPass(db, provider);
    // Evict vectors orphaned by session/message deletes after a productive pass.
    // (Orphans are otherwise harmless — never reused ids, filtered at search.)
    if (processed > 0) {
      gcOrphans(db, MESSAGE_VECTORS, 'SELECT id FROM messages');
    }
    // Same single-flight + same warm provider: index the Work Timeline (L1) too,
    // so search/Recap span the curated journal. Runs after messages to keep the
    // chat hot path first; GC is internally guarded against FS flakiness.
    const tl = await runTimelineIndexPass(db, provider);
    gcTimelineVectors(db, tl);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[vector] index pass failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

/** Start the background sweep. Idempotent; safe to call when degraded (no-ops
 *  each tick until a provider warms up). */
export function startMessageIndexer(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.(); // never keep the process alive
  void tick(); // kick an immediate first pass
}

export function stopMessageIndexer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
  schemaReady = false;
  __resetTimelineIndexerForTest();
}
