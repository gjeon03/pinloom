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
import {
  __resetWikiIndexerForTest,
  gcWikiVectors,
  runWikiIndexPass,
} from './wiki-indexer.js';

const BATCH = 32;
const INTERVAL_MS = 5000;
const nextTick = () => new Promise<void>((r) => setImmediate(r));

// Plain indexed mirror of which message ids are embedded (migration 40). The
// old pending query anti-joined against the vec0 virtual table, which forced a
// full scan of it every sweep (~100ms even when idle — the event-loop blocker).
// An anti-join against this B-tree-indexed table is O(log n). Mirrors the
// timeline/wiki indexers' *_index_state tables.
const MESSAGE_INDEX_STATE = 'message_index_state';

// Pending = content-bearing user/assistant rows (mirrors the FTS predicate),
// not already embedded. source_message_id IS NULL skips worker-mirror rows.
const PENDING_SQL = `
  SELECT id, content FROM messages
  WHERE role IN ('user','assistant') AND content <> '' AND source_message_id IS NULL
    AND id NOT IN (SELECT doc_id FROM ${MESSAGE_INDEX_STATE})
  ORDER BY created_at ASC
  LIMIT ?`;

// Create the vec table on first run; on a model/dim change (e.g. switching to
// Ollama bge-m3 at 1024) drop + re-embed. Surfaced via log, not silent.
function ensureSchema(db: Database, provider: EmbeddingProvider): void {
  const meta = getVectorMeta(db, MESSAGE_VECTORS);
  if (!meta) {
    ensureVectorTable(db, MESSAGE_VECTORS, provider.dim);
    setVectorMeta(db, MESSAGE_VECTORS, provider.id, provider.dim);
  } else if (meta.modelId !== provider.id || meta.dim !== provider.dim) {
    // eslint-disable-next-line no-console
    console.error(
      `[vector] embedding model changed (${meta.modelId} → ${provider.id}); rebuilding + re-embedding`,
    );
    rebuildVectorTable(db, MESSAGE_VECTORS, provider.dim);
    setVectorMeta(db, MESSAGE_VECTORS, provider.id, provider.dim);
    db.exec(`DELETE FROM ${MESSAGE_INDEX_STATE}`); // dropped vectors → re-embed all
  }

  backfillMessageIndexState(db);
}

/**
 * One-time backfill: an existing install already has embedded vectors but the
 * state table (migration 40) is empty. Seed it from the vec table ONCE so the
 * whole corpus isn't re-embedded. This is the only remaining scan of the vec0
 * table — after it the pending query is a pure B-tree anti-join. Returns the
 * number of rows seeded (0 if already populated / empty corpus). Exported for
 * tests.
 */
export function backfillMessageIndexState(db: Database): number {
  const stateEmpty =
    (db.prepare(`SELECT COUNT(*) AS c FROM ${MESSAGE_INDEX_STATE}`).get() as { c: number }).c === 0;
  if (!stateEmpty) return 0;
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO ${MESSAGE_INDEX_STATE} (doc_id, indexed_at)
         SELECT doc_id, ? FROM ${MESSAGE_VECTORS}`,
      )
      .run(new Date().toISOString());
    return info.changes;
  } catch {
    return 0; // vec table not queryable yet — the next sweep indexes from scratch.
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
  const markIndexed = db.prepare(
    `INSERT OR REPLACE INTO ${MESSAGE_INDEX_STATE} (doc_id, indexed_at) VALUES (?, ?)`,
  );
  const writeBatch = db.transaction(() => {
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i++) {
      upsertVector(db, MESSAGE_VECTORS, rows[i].id, vecs[i]);
      markIndexed.run(rows[i].id, now); // keep the fast-lookup mirror in sync
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

/** The most recent indexing failure, surfaced to the Settings UI so a silent
 *  embedding breakage (e.g. an Ollama 400 on oversized input) is visible instead
 *  of buried in logs. Cleared after a fully-clean sweep. */
export interface IndexError {
  pass: 'schema' | 'timeline' | 'wiki' | 'message';
  message: string;
  at: string;
}
let lastIndexError: IndexError | null = null;
export function getLastIndexError(): IndexError | null {
  return lastIndexError;
}

async function tick(): Promise<void> {
  if (running) return; // single-flight
  const provider = getEmbeddingProvider();
  if (!provider) return; // not warm / FTS-only
  running = true;
  let erroredThisTick = false;
  const record = (pass: IndexError['pass'], err: unknown) => {
    erroredThisTick = true;
    lastIndexError = {
      pass,
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
    // eslint-disable-next-line no-console
    console.error(`[vector] ${pass} pass failed:`, lastIndexError.message);
  };
  try {
    const db = getDb();
    try {
      if (!schemaReady) {
        ensureSchema(db, provider);
        schemaReady = true;
      }
    } catch (err) {
      record('schema', err);
      return; // can't index without the message schema; try again next tick
    }
    // Each corpus is indexed in its OWN try/catch so one failing pass never
    // starves the others (a single oversized message that an embedder rejects
    // used to throw the shared pass and block timeline + wiki forever).
    //
    // The small curated corpora (timeline L1, wiki L2) go FIRST: they re-embed
    // in seconds, so a large message backfill — e.g. a full re-embed after an
    // embedding-model switch — can't keep them empty for the whole drain. In
    // steady state both are a cheap unchanged-hash check, so messages still
    // index promptly right after.
    try {
      const tl = await runTimelineIndexPass(db, provider);
      gcTimelineVectors(db, tl);
    } catch (err) {
      record('timeline', err);
    }
    try {
      const wk = await runWikiIndexPass(db, provider);
      gcWikiVectors(db, wk);
    } catch (err) {
      record('wiki', err);
    }
    try {
      const processed = await runIndexPass(db, provider);
      // Evict vectors orphaned by session/message deletes after a productive
      // pass. (Orphans are otherwise harmless — never reused ids, filtered out
      // at search.)
      if (processed > 0) {
        gcOrphans(db, MESSAGE_VECTORS, 'SELECT id FROM messages');
        gcOrphans(db, MESSAGE_INDEX_STATE, 'SELECT id FROM messages'); // keep mirror in sync
      }
    } catch (err) {
      record('message', err);
    }
    if (!erroredThisTick) lastIndexError = null; // a clean sweep clears the banner
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
  lastIndexError = null;
  __resetTimelineIndexerForTest();
  __resetWikiIndexerForTest();
}
