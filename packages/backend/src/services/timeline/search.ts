// Semantic search over the Work Timeline (L1) vectors — the ⌘K + Recap arm.
// Vector-only (timeline entries aren't in the message FTS index); guarded on a
// shared embedding space so its distances are comparable to message_vectors.

import type { Database } from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { getProjectWikiSlugByProjectId } from '../wiki-sync.js';
import { getVectorMeta, knn } from '../vector-store.js';
import { isVectorAvailable } from '../../db/connection.js';
import { readEntry } from './store.js';
import { TIMELINE_VECTORS } from './indexer.js';

export interface TimelineHit {
  projectId: string;
  projectName: string;
  date: string;
  excerpt: string;
}

const EXCERPT_LEN = 160;

function splitDocId(docId: string): { projectId: string; date: string } {
  return { projectId: docId.slice(0, -11), date: docId.slice(-10) };
}

/** Returns the top timeline entries semantically nearest to `query` (empty when
 *  the provider/extension isn't ready or the spaces don't match). */
export async function searchTimeline(
  db: Database,
  query: string,
  opts: { projectId?: string; limit?: number },
  provider: EmbeddingProvider | null,
): Promise<TimelineHit[]> {
  const q = query.trim();
  if (!q || !provider || !isVectorAvailable()) return [];
  const meta = getVectorMeta(db, TIMELINE_VECTORS);
  if (!meta || meta.modelId !== provider.id) return [];

  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  let qvec: Float32Array;
  try {
    qvec = await provider.embedQuery(q);
  } catch {
    return [];
  }
  const k = Math.min(opts.projectId ? limit * 4 : limit * 2, 100);
  const nameStmt = db.prepare('SELECT name FROM projects WHERE id = ?');
  const hits: TimelineHit[] = [];
  for (const h of knn(db, TIMELINE_VECTORS, qvec, k)) {
    const { projectId, date } = splitDocId(h.docId);
    if (opts.projectId && projectId !== opts.projectId) continue;
    const content = readEntry(getProjectWikiSlugByProjectId(projectId), date);
    if (!content) continue; // file gone since indexing
    const projectName =
      (nameStmt.get(projectId) as { name: string } | undefined)?.name ?? projectId;
    // first non-heading line as a teaser, capped
    const teaser =
      content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#')) ?? content.trim();
    hits.push({ projectId, projectName, date, excerpt: teaser.slice(0, EXCERPT_LEN) });
    if (hits.length >= limit) break;
  }
  return hits;
}
