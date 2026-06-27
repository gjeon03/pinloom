import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, isVectorAvailable } from '../db/connection.js';
import { ensureVectorTable, setVectorMeta, upsertVector } from './vector-store.js';
import { WIKI_VECTORS } from './wiki-indexer.js';
import { buildWikiGraph } from './wiki-graph.js';

const db = getDb();
const available = isVectorAvailable();

async function writePage(home: string, slug: string, content: string) {
  const dir = path.join(home, '.pinloom', 'wiki', 'pages');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), content);
}

describe.skipIf(!available)('buildWikiGraph', () => {
  let home: string;
  beforeEach(async () => {
    db.exec(`DELETE FROM wiki_index_state; DROP TABLE IF EXISTS ${WIKI_VECTORS};`);
    try {
      db.exec(`DELETE FROM vector_meta WHERE table_name='${WIKI_VECTORS}';`);
    } catch {
      // meta not created yet
    }
    ensureVectorTable(db, WIKI_VECTORS, 3);
    setVectorMeta(db, WIKI_VECTORS, 'fake', 3);
    home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-wkgraph-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('connects near-identical vectors and isolates an orthogonal one', async () => {
    // a, b nearly identical → high cosine → edge. c orthogonal → no edge (< 0.6).
    upsertVector(db, WIKI_VECTORS, 'a', new Float32Array([1, 0.02, 0]));
    upsertVector(db, WIKI_VECTORS, 'b', new Float32Array([1, 0, 0.02]));
    upsertVector(db, WIKI_VECTORS, 'c', new Float32Array([0, 1, 0]));
    await writePage(home, 'a', '# Page A');
    await writePage(home, 'b', '# Page B');
    await writePage(home, 'c', '# Page C');

    const g = buildWikiGraph(db, home);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(g.nodes.find((n) => n.id === 'a')?.title).toBe('Page A'); // title from heading
    expect(g.truncated).toBe(false);
    // exactly one undirected edge a↔b; c connects to nobody
    expect(g.edges).toHaveLength(1);
    const e = g.edges[0];
    expect([e.source, e.target].sort()).toEqual(['a', 'b']);
    expect(e.weight).toBeGreaterThan(0.6);
  });

  it('drops a node whose page file was deleted since indexing (no ghost)', async () => {
    upsertVector(db, WIKI_VECTORS, 'live', new Float32Array([1, 0, 0]));
    upsertVector(db, WIKI_VECTORS, 'ghost', new Float32Array([1, 0.01, 0]));
    await writePage(home, 'live', '# Live'); // 'ghost' has a vector but NO file
    const g = buildWikiGraph(db, home);
    expect(g.nodes.map((n) => n.id)).toEqual(['live']); // ghost dropped
    expect(g.edges).toHaveLength(0); // its edge pruned with it
  });

  it('is empty + safe when nothing is indexed', () => {
    db.exec(`DELETE FROM ${WIKI_VECTORS};`);
    expect(buildWikiGraph(db, home)).toEqual({ nodes: [], edges: [], truncated: false });
  });

  it('attaches the project group to each node (slug → project → group_id)', async () => {
    db.exec('DELETE FROM projects; DELETE FROM project_groups;');
    db.prepare(
      'INSERT INTO project_groups (id,name,order_index,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('g1', 'Work', 0, 't', 't');
    // cwd basename → slug 'work-app', which the wiki page's applies_to references.
    db.prepare(
      'INSERT INTO projects (id,name,cwd,group_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run('pw', 'Work App', '/tmp/work-app', 'g1', 't', 't');
    upsertVector(db, WIKI_VECTORS, 'conventions-work', new Float32Array([1, 0, 0]));
    upsertVector(db, WIKI_VECTORS, 'conventions-misc', new Float32Array([0, 1, 0]));
    await writePage(home, 'conventions-work', '---\napplies_to: [work-app]\n---\n# Work conv');
    await writePage(home, 'conventions-misc', '---\napplies_to: [nobody]\n---\n# Misc conv');

    const g = buildWikiGraph(db, home);
    const work = g.nodes.find((n) => n.id === 'conventions-work');
    const misc = g.nodes.find((n) => n.id === 'conventions-misc');
    expect(work?.group).toBe('work-app');
    expect(work?.groupId).toBe('g1'); // mapped through the owning project's group
    expect(misc?.groupId).toBeNull(); // applies_to matches no project → ungrouped
  });
});
