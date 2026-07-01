// Wiki indexer — vector-indexes the wiki PAGES (L2 curated convention notes) so
// ⌘K search + Recap span them too, completing the L0 (messages) / L1 (timeline)
// / L2 (wiki) corpus. Mirrors the timeline indexer: runs inside the message
// indexer's sweep (one timer, one single-flight, same warm provider).
//
// Reads the wiki files directly (with a `home` seam for tests) rather than via
// wiki-sync, whose WIKI_ROOT is a module const that can't be isolated per-test.
// docId = the page slug (flat filename sans .md) — stable + reversible.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { EmbeddingProvider } from './embeddings/types.js';
import {
  ensureVectorTable,
  getVectorMeta,
  rebuildVectorTable,
  setVectorMeta,
  upsertVector,
} from './vector-store.js';
import { isVectorAvailable } from '../db/connection.js';

export const WIKI_VECTORS = 'wiki_vectors';

const BATCH = 16;
const nextTick = () => new Promise<void>((r) => setImmediate(r));

function pagesDir(home?: string): string {
  return path.join(home ?? os.homedir(), '.pinloom', 'wiki', 'pages');
}

/** Page slugs = relPath sans `.md` (flat `foo.md` → `foo`; promoted topic dir
 *  `topic/index.md` → `topic/index`). Matches wiki-reader's promoted-dir model so
 *  the corpus never disagrees with the dashboard. Throws on a real read error (so
 *  the indexer can refuse to GC); returns [] for a missing dir (no wiki yet). */
export function listWikiSlugs(home?: string): string[] {
  const dir = pagesDir(home);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (existsSync(path.join(dir, e.name, 'index.md'))) out.push(`${e.name}/index`);
    } else if (e.name.endsWith('.md')) {
      out.push(e.name.slice(0, -3));
    }
  }
  return out.sort();
}

export function readWikiPage(slug: string, home?: string): string | null {
  try {
    return readFileSync(path.join(pagesDir(home), `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** Display title: first markdown heading, else the frontmatter summary, else slug. */
export function wikiTitle(content: string, slug: string): string {
  const h = content.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  const s = content.match(/^summary:\s*"?(.+?)"?\s*$/m);
  if (s) return s[1].trim();
  return slug;
}

export function wikiContentHash(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex');
}

let schemaReady = false;

// mtime short-circuit: reading + SHA-256 hashing every page every sweep is the
// steady-state cost that pins the CPU (and blocks the event loop) even when
// nothing changed. Cache each page's last-seen mtime; if it's unchanged we skip
// the read/hash/DB-lookup entirely. In-memory (no migration): a restart just
// re-hashes once, then the cache makes subsequent sweeps ~free (stat only).
const wikiMtimeCache = new Map<string, number>();

function ensureSchema(db: Database, provider: EmbeddingProvider): void {
  const meta = getVectorMeta(db, WIKI_VECTORS);
  if (!meta) {
    ensureVectorTable(db, WIKI_VECTORS, provider.dim);
    setVectorMeta(db, WIKI_VECTORS, provider.id, provider.dim);
    return;
  }
  if (meta.modelId !== provider.id || meta.dim !== provider.dim) {
    // eslint-disable-next-line no-console
    console.error(`[wiki-vector] embedding model changed (${meta.modelId} → ${provider.id}); rebuilding`);
    rebuildVectorTable(db, WIKI_VECTORS, provider.dim);
    setVectorMeta(db, WIKI_VECTORS, provider.id, provider.dim);
    db.exec('DELETE FROM wiki_index_state');
  }
}

export interface WikiPassResult {
  processed: number;
  validDocIds: Set<string>;
  walkOk: boolean;
  rootExists: boolean;
}

export async function runWikiIndexPass(
  db: Database,
  provider: EmbeddingProvider,
  home?: string,
): Promise<WikiPassResult> {
  if (!isVectorAvailable())
    return { processed: 0, validDocIds: new Set(), walkOk: false, rootExists: false };
  if (!schemaReady) {
    ensureSchema(db, provider);
    schemaReady = true;
  }

  const rootExists = existsSync(pagesDir(home));
  let walkOk = true;
  let slugs: string[] = [];
  try {
    slugs = listWikiSlugs(home);
  } catch {
    walkOk = false;
  }

  const validDocIds = new Set<string>();
  const changed: { slug: string; content: string; hash: string; mtime: number }[] = [];
  for (const slug of slugs) {
    validDocIds.add(slug);
    // Cheap change probe first: if the file's mtime matches what we last
    // indexed, skip the (expensive) read + hash + DB lookup entirely.
    let mtime = 0;
    try {
      mtime = statSync(path.join(pagesDir(home), `${slug}.md`)).mtimeMs;
    } catch {
      continue; // gone between listing and stat — GC will drop it
    }
    if (wikiMtimeCache.get(slug) === mtime) continue;
    const content = readWikiPage(slug, home);
    if (!content || content.trim() === '') continue;
    const hash = wikiContentHash(content);
    const prev = db
      .prepare('SELECT content_hash AS h FROM wiki_index_state WHERE doc_id = ?')
      .get(slug) as { h: string } | undefined;
    if (prev && prev.h === hash) {
      wikiMtimeCache.set(slug, mtime); // content already indexed — remember mtime so we don't re-hash
      continue;
    }
    changed.push({ slug, content, hash, mtime });
  }

  const stateStmt = db.prepare(
    `INSERT INTO wiki_index_state (doc_id, content_hash, indexed_at) VALUES (?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at`,
  );
  let processed = 0;
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    const vecs = await provider.embedPassages(batch.map((c) => c.content));
    const now = new Date().toISOString();
    for (let j = 0; j < batch.length; j++) {
      upsertVector(db, WIKI_VECTORS, batch[j].slug, vecs[j]);
      stateStmt.run(batch[j].slug, batch[j].hash, now);
      wikiMtimeCache.set(batch[j].slug, batch[j].mtime); // remember mtime for the short-circuit
    }
    processed += batch.length;
    if (i + BATCH < changed.length) await nextTick();
  }

  return { processed, validDocIds, walkOk, rootExists };
}

export function gcWikiVectors(db: Database, result: WikiPassResult): number {
  if (!isVectorAvailable()) return 0;
  if (!result.walkOk || !result.rootExists) return 0;
  const ids = db.prepare('SELECT doc_id AS id FROM wiki_index_state').all() as { id: string }[];
  const orphans = ids.map((r) => r.id).filter((id) => !result.validDocIds.has(id));
  if (orphans.length === 0) return 0;
  const tx = db.transaction(() => {
    for (const id of orphans) {
      db.prepare(`DELETE FROM ${WIKI_VECTORS} WHERE doc_id = ?`).run(id);
      db.prepare('DELETE FROM wiki_index_state WHERE doc_id = ?').run(id);
    }
  });
  tx();
  return orphans.length;
}

export function __resetWikiIndexerForTest(): void {
  schemaReady = false;
}
