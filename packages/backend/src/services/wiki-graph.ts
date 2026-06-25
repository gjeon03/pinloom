// Wiki similarity graph — nodes are wiki pages, edges connect each page to its
// most semantically-similar neighbours (cosine over the wiki vectors). A
// "related notes" map that works WITHOUT any explicit [[links]] (the auto-synced
// wiki has none) by leaning on the embeddings we already build. Empty + safe
// when the wiki isn't vector-indexed yet (provider/extension cold).

import type { Database } from 'better-sqlite3';
import { readVectors } from './vector-store.js';
import { WIKI_VECTORS, readWikiPage, wikiTitle } from './wiki-indexer.js';

export interface WikiGraph {
  nodes: { id: string; title: string }[];
  edges: { source: string; target: string; weight: number }[];
}

const TOP_K = 4; // neighbours kept per node
const MIN_SIM = 0.6; // cosine floor — below this, pages aren't meaningfully related

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
  const vecs = readVectors(db, WIKI_VECTORS);
  const nodes = vecs.map((v) => {
    const content = readWikiPage(v.docId, home);
    return { id: v.docId, title: content ? wikiTitle(content, v.docId) : v.docId };
  });

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
  return { nodes, edges: [...edges.values()] };
}
