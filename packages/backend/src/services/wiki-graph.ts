// Wiki similarity graph — nodes are wiki pages, edges connect each page to its
// most semantically-similar neighbours (cosine over the wiki vectors). A
// "related notes" map that works WITHOUT any explicit [[links]] (the auto-synced
// wiki has none) by leaning on the embeddings we already build. Empty + safe
// when the wiki isn't vector-indexed yet (provider/extension cold).

import type { Database } from 'better-sqlite3';
import { readVectors } from './vector-store.js';
import { WIKI_VECTORS, readWikiPage, wikiTitle } from './wiki-indexer.js';

export interface WikiGraph {
  nodes: { id: string; title: string; group: string }[];
  edges: { source: string; target: string; weight: number }[];
  /** True when the wiki exceeded MAX_NODES and the graph was capped. */
  truncated: boolean;
}

/** The page's owning project — first `applies_to` entry from the frontmatter
 *  (e.g. `kso-frontend`), used to colour nodes by project. Falls back to the
 *  trailing slug tokens, then 'global'. */
function wikiGroup(content: string, slug: string): string {
  const m = content.match(/^applies_to:\s*\[([^\]]*)\]/m);
  const first = m?.[1]?.split(',')[0]?.trim();
  if (first) return first;
  const tail = slug.split('-').slice(-2).join('-');
  return tail || 'global';
}

const TOP_K = 4; // neighbours kept per node
const MIN_SIM = 0.6; // cosine floor — below this, pages aren't meaningfully related
// Bound the O(n²) cosine + the synchronous readFileSync-per-node so a large wiki
// can't stall the event loop on this request-thread endpoint (review MED-2).
const MAX_NODES = 400;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function buildWikiGraph(db: Database, home?: string): WikiGraph {
  const all = readVectors(db, WIKI_VECTORS);
  const truncated = all.length > MAX_NODES;
  // Resolve titles + drop pages deleted since indexing (their deep-link would
  // 404 and they'd be dangling graph nodes — review LOW-3). GC removes the vector
  // on the next index pass; here we just don't surface a ghost.
  const vecs = all
    .slice(0, MAX_NODES)
    .map((v) => {
      const content = readWikiPage(v.docId, home); // one read per node
      return content
        ? {
            docId: v.docId,
            vec: v.vec,
            title: wikiTitle(content, v.docId),
            group: wikiGroup(content, v.docId),
          }
        : null;
    })
    .filter(
      (v): v is { docId: string; vec: Float32Array; title: string; group: string } => v !== null,
    );
  const nodes = vecs.map((v) => ({ id: v.docId, title: v.title, group: v.group }));

  // Top-K neighbours per node, collapsed to undirected edges (keep the max weight
  // when both directions propose the same pair).
  const edges = new Map<string, { source: string; target: string; weight: number }>();
  for (let i = 0; i < vecs.length; i++) {
    const sims: { j: number; s: number }[] = [];
    for (let j = 0; j < vecs.length; j++) {
      if (i === j) continue;
      const s = cosine(vecs[i].vec, vecs[j].vec);
      if (s >= MIN_SIM) sims.push({ j, s });
    }
    sims.sort((x, y) => y.s - x.s);
    for (const { j, s } of sims.slice(0, TOP_K)) {
      const a = vecs[i].docId;
      const b = vecs[j].docId;
      const [source, target] = a < b ? [a, b] : [b, a];
      const key = `${source}|${target}`;
      const prev = edges.get(key);
      if (!prev || s > prev.weight) edges.set(key, { source, target, weight: s });
    }
  }
  return { nodes, edges: [...edges.values()], truncated };
}
