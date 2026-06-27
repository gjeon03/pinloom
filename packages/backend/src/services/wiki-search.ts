// Semantic search over the wiki (L2) vectors — the ⌘K + Recap wiki arm. Vector
// only (wiki pages aren't in the message FTS); guarded on a shared embedding
// space so distances are comparable to the message/timeline arms.

import type { Database } from 'better-sqlite3';
import type { EmbeddingProvider } from './embeddings/types.js';
import { getVectorMeta, knn } from './vector-store.js';
import { isVectorAvailable } from '../db/connection.js';
import { WIKI_VECTORS, readWikiPage, wikiTitle } from './wiki-indexer.js';

export interface WikiHit {
  slug: string;
  title: string;
  excerpt: string;
}

const EXCERPT_LEN = 160;

/** The page's `applies_to` slugs (empty ⇒ global / unscoped). */
function appliesTo(content: string): string[] {
  const m = content.match(/^applies_to:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip YAML frontmatter + headings/markers so the teaser is real prose. */
function teaser(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return (
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--')) ?? body.trim()
  ).slice(0, EXCERPT_LEN);
}

export async function searchWiki(
  db: Database,
  query: string,
  // projectSlugs scopes to a project group: a hit shows iff it's global
  // (applies_to empty / 'global') or its applies_to intersects the set.
  opts: { limit?: number; projectSlugs?: string[] },
  provider: EmbeddingProvider | null,
  home?: string,
): Promise<WikiHit[]> {
  const q = query.trim();
  if (!q || !provider || !isVectorAvailable()) return [];
  const meta = getVectorMeta(db, WIKI_VECTORS);
  if (!meta || meta.modelId !== provider.id) return [];

  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  let qvec: Float32Array;
  try {
    qvec = await provider.embedQuery(q);
  } catch {
    return [];
  }
  const slugSet =
    opts.projectSlugs && opts.projectSlugs.length > 0 ? new Set(opts.projectSlugs) : null;
  const hits: WikiHit[] = [];
  for (const h of knn(db, WIKI_VECTORS, qvec, Math.min(limit * (slugSet ? 4 : 2), 100))) {
    const content = readWikiPage(h.docId, home);
    if (!content) continue; // page gone since indexing
    if (slugSet) {
      const scopes = appliesTo(content);
      // Keep global/unscoped pages in every scope; drop pages owned only by
      // projects outside the group.
      const global = scopes.length === 0 || scopes.includes('global');
      if (!global && !scopes.some((s) => slugSet.has(s))) continue;
    }
    hits.push({ slug: h.docId, title: wikiTitle(content, h.docId), excerpt: teaser(content) });
    if (hits.length >= limit) break;
  }
  return hits;
}
