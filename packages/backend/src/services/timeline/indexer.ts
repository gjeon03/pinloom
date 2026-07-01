// Timeline indexer — vector-indexes the Work Timeline (L1) entries so semantic
// search + Recap span the curated daily journal, not just raw messages
// (knowledge-system-v3 fast-follow). Runs INSIDE the message-indexer's sweep
// (one timer, one single-flight, same warm provider) to avoid two indexers
// competing on the event loop.
//
// Key decisions (from the plan review):
//  - docId = `${projectId}:${date}` — projectId is durable; the on-disk slug is
//    rename-unstable and not cleanly reversible to a project.
//  - Change detection hashes NORMALIZED content so a re-distill that only
//    reshuffles whitespace doesn't force a re-embed.
//  - GC only after a fully successful filesystem walk and never against an empty
//    valid set — a transient FS error must not wipe the index.
//  - Same embedding provider as message_vectors → one shared vector space.

import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { existsSync, statSync } from 'node:fs';
import { getProjectWikiSlugByProjectId } from '../wiki-sync.js';
import { entryPath, getTimelineRoot, listDates, readEntry } from './store.js';
import {
  ensureVectorTable,
  getVectorMeta,
  rebuildVectorTable,
  setVectorMeta,
  upsertVector,
} from '../vector-store.js';
import { isVectorAvailable } from '../../db/connection.js';

export const TIMELINE_VECTORS = 'timeline_vectors';

const BATCH = 16;
const nextTick = () => new Promise<void>((r) => setImmediate(r));

/** Hash of whitespace-normalized content — avoids re-embedding on trivial edits. */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex');
}

let schemaReady = false;

// mtime short-circuit (same rationale as the wiki indexer): past days are
// immutable, so re-reading + hashing every day-file every sweep is wasted CPU
// that keeps the machine from idling. Cache each entry's mtime; skip read+hash
// when unchanged. In-memory — a restart re-hashes once, then sweeps are ~free.
const timelineMtimeCache = new Map<string, number>();

/** Create the timeline vec table on first run; rebuild + re-embed on a model/dim
 *  change (mirrors message-indexer.ensureSchema). */
function ensureSchema(db: Database, provider: EmbeddingProvider): void {
  const meta = getVectorMeta(db, TIMELINE_VECTORS);
  if (!meta) {
    ensureVectorTable(db, TIMELINE_VECTORS, provider.dim);
    setVectorMeta(db, TIMELINE_VECTORS, provider.id, provider.dim);
    return;
  }
  if (meta.modelId !== provider.id || meta.dim !== provider.dim) {
    // eslint-disable-next-line no-console
    console.error(
      `[timeline-vector] embedding model changed (${meta.modelId} → ${provider.id}); rebuilding`,
    );
    rebuildVectorTable(db, TIMELINE_VECTORS, provider.dim);
    setVectorMeta(db, TIMELINE_VECTORS, provider.id, provider.dim);
    db.exec('DELETE FROM timeline_index_state'); // force a full re-embed under the new model
  }
}

interface Changed {
  docId: string;
  content: string;
  hash: string;
  mtime: number;
}

export interface TimelinePassResult {
  processed: number;
  validDocIds: Set<string>;
  /** False if any filesystem read threw — GC must be skipped to avoid mass-delete. */
  walkOk: boolean;
  /** False if the timeline ROOT dir is missing (e.g. home unmounted) — an empty
   *  valid set is only trustworthy when the root exists. A missing *project* dir
   *  is normal (no entries yet) and does not clear this. */
  rootExists: boolean;
}

/** One pass: walk every visible project's timeline entries, embed changed ones.
 *  Walk starts from `projects` (durable id) → slug → files. */
export async function runTimelineIndexPass(
  db: Database,
  provider: EmbeddingProvider,
  home?: string,
): Promise<TimelinePassResult> {
  // No vec extension → indexing is a no-op (and we must NOT write state rows
  // without a backing vector, else they'd look "indexed" forever — review L1).
  if (!isVectorAvailable())
    return { processed: 0, validDocIds: new Set(), walkOk: false, rootExists: false };
  const rootExists = existsSync(getTimelineRoot(home));
  if (!schemaReady) {
    ensureSchema(db, provider);
    schemaReady = true;
  }

  const projects = db.prepare('SELECT id FROM projects WHERE hidden = 0').all() as {
    id: string;
  }[];
  const validDocIds = new Set<string>();
  const changed: Changed[] = [];
  let walkOk = true;

  for (const p of projects) {
    let slug: string;
    try {
      slug = getProjectWikiSlugByProjectId(p.id);
    } catch {
      continue;
    }
    let dates: string[];
    try {
      dates = listDates(slug, home);
    } catch {
      walkOk = false; // couldn't enumerate this project's dir — don't trust the valid set
      continue;
    }
    for (const date of dates) {
      const docId = `${p.id}:${date}`;
      validDocIds.add(docId);
      // Cheap change probe first — skip read+hash+lookup when mtime is unchanged.
      let mtime = 0;
      try {
        mtime = statSync(entryPath(slug, date, home)).mtimeMs;
      } catch {
        continue;
      }
      if (timelineMtimeCache.get(docId) === mtime) continue;
      let content: string | null;
      try {
        content = readEntry(slug, date, home);
      } catch {
        walkOk = false;
        continue;
      }
      if (!content || content.trim() === '') continue;
      const hash = contentHash(content);
      const prev = db
        .prepare('SELECT content_hash AS h FROM timeline_index_state WHERE doc_id = ?')
        .get(docId) as { h: string } | undefined;
      if (prev && prev.h === hash) {
        timelineMtimeCache.set(docId, mtime);
        continue;
      }
      changed.push({ docId, content, hash, mtime });
    }
  }

  const stateStmt = db.prepare(
    `INSERT INTO timeline_index_state (doc_id, content_hash, indexed_at) VALUES (?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at`,
  );
  let processed = 0;
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    const vecs = await provider.embedPassages(batch.map((c) => c.content));
    const now = new Date().toISOString();
    for (let j = 0; j < batch.length; j++) {
      // upsertVector opens its own transaction (delete+insert), so don't wrap it
      // in another — write the state row right after it succeeds. A crash between
      // the two just re-embeds next pass (idempotent); both no-op without vec.
      upsertVector(db, TIMELINE_VECTORS, batch[j].docId, vecs[j]);
      stateStmt.run(batch[j].docId, batch[j].hash, now);
      timelineMtimeCache.set(batch[j].docId, batch[j].mtime);
    }
    processed += batch.length;
    if (i + BATCH < changed.length) await nextTick();
  }

  return { processed, validDocIds, walkOk, rootExists };
}

/** Evict vectors + state for entries whose file is gone. Safe-by-default: skips
 *  on a failed walk or an empty valid set (treats those as untrustworthy). */
export function gcTimelineVectors(db: Database, result: TimelinePassResult): number {
  if (!isVectorAvailable()) return 0;
  // Trust the valid set only on a clean walk with the root present. An empty set
  // is then legitimate (all entries deleted) and we GC; a missing root means the
  // FS is in a bad state → skip rather than wipe everything.
  if (!result.walkOk || !result.rootExists) return 0;
  const ids = db
    .prepare('SELECT doc_id AS id FROM timeline_index_state')
    .all() as { id: string }[];
  const orphans = ids.map((r) => r.id).filter((id) => !result.validDocIds.has(id));
  if (orphans.length === 0) return 0;
  const tx = db.transaction(() => {
    for (const id of orphans) {
      db.prepare(`DELETE FROM ${TIMELINE_VECTORS} WHERE doc_id = ?`).run(id);
      db.prepare('DELETE FROM timeline_index_state WHERE doc_id = ?').run(id);
    }
  });
  tx();
  return orphans.length;
}

/** Test-only reset of the once-per-process schema flag. */
export function __resetTimelineIndexerForTest(): void {
  schemaReady = false;
}
