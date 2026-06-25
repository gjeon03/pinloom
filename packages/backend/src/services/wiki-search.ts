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
  opts: { limit?: number },
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
  const hits: WikiHit[] = [];
  for (const h of knn(db, WIKI_VECTORS, qvec, Math.min(limit * 2, 100))) {
    const content = readWikiPage(h.docId, home);
    if (!content) continue; // page gone since indexing
    hits.push({ slug: h.docId, title: wikiTitle(content, h.docId), excerpt: teaser(content) });
    if (hits.length >= limit) break;
  }
  return hits;
}
