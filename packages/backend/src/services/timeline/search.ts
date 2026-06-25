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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// docId = `${projectId}:${date}`. projectId is a nanoid (no colon) so the FIRST
// colon is the separator; validate the date so a malformed docId can't reach
// readEntry's assertDate and 500 the whole /api/search (review H1).
function parseDocId(docId: string): { projectId: string; date: string } | null {
  const i = docId.indexOf(':');
  if (i < 0) return null;
  const date = docId.slice(i + 1);
  if (!DATE_RE.test(date)) return null;
  return { projectId: docId.slice(0, i), date };
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
  // Resolve slug + name ONCE per project (getProjectWikiSlugByProjectId loads the
  // whole project table on each call — don't run it per knn hit, review H2).
  const nameStmt = db.prepare('SELECT name FROM projects WHERE id = ?');
  const projCache = new Map<string, { slug: string; name: string } | null>();
  function resolveProject(projectId: string): { slug: string; name: string } | null {
    if (projCache.has(projectId)) return projCache.get(projectId) ?? null;
    let resolved: { slug: string; name: string } | null = null;
    try {
      const name =
        (nameStmt.get(projectId) as { name: string } | undefined)?.name ?? projectId;
      resolved = { slug: getProjectWikiSlugByProjectId(projectId), name };
    } catch {
      resolved = null;
    }
    projCache.set(projectId, resolved);
    return resolved;
  }

  const hits: TimelineHit[] = [];
  for (const h of knn(db, TIMELINE_VECTORS, qvec, k)) {
    const parsed = parseDocId(h.docId);
    if (!parsed) continue;
    const { projectId, date } = parsed;
    if (opts.projectId && projectId !== opts.projectId) continue;
    const proj = resolveProject(projectId);
    if (!proj) continue;
    let content: string | null;
    try {
      content = readEntry(proj.slug, date);
    } catch {
      continue; // bad date / FS error — skip, never 500 the search
    }
    if (!content) continue; // file gone since indexing
    const teaser =
      content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#')) ?? content.trim();
    hits.push({ projectId, projectName: proj.name, date, excerpt: teaser.slice(0, EXCERPT_LEN) });
    if (hits.length >= limit) break;
  }
  return hits;
}
