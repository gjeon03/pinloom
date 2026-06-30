import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, isVectorAvailable } from '../db/connection.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { indexOneBatch, runIndexPass, backfillMessageIndexState } from './message-indexer.js';
import {
  MESSAGE_VECTORS,
  ensureVectorTable,
  setVectorMeta,
  upsertVector,
  vectorRowCount,
} from './vector-store.js';

const db = getDb();
const available = isVectorAvailable();

// Deterministic fake — content is irrelevant to indexing correctness; we just
// need fixed-dim vectors and to record which passages were embedded.
const embedded: string[] = [];
const fakeProvider: EmbeddingProvider = {
  id: 'fake',
  dim: 4,
  embedQuery: async () => new Float32Array(4),
  embedPassages: async (texts) => {
    embedded.push(...texts);
    return texts.map(() => new Float32Array(4));
  },
};

function seedMessages() {
  db.prepare(
    "INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('ip','IP','/tmp/ip','t','t')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES ('is','ip','S','t','t')",
  ).run();
  const ins = db.prepare(
    'INSERT INTO messages (id,session_id,role,content,source_message_id,created_at) VALUES (?,?,?,?,?,?)',
  );
  ins.run('u1', 'is', 'user', 'hello world', null, '1');
  ins.run('a1', 'is', 'assistant', 'a reply', null, '2');
  ins.run('empty', 'is', 'assistant', '', null, '3'); // streaming placeholder
  ins.run('tool', 'is', 'tool', '$ Edit: x.ts', null, '4'); // tool row
  ins.run('mirror', 'is', 'assistant', 'mirror', 'orig-1', '5'); // worker mirror
}

describe.skipIf(!available)('message-indexer', () => {
  beforeAll(() => {
    ensureVectorTable(db, MESSAGE_VECTORS, fakeProvider.dim);
    setVectorMeta(db, MESSAGE_VECTORS, fakeProvider.id, fakeProvider.dim);
    seedMessages();
  });

  it('indexes only content-bearing user/assistant rows (skips empty/tool/mirror)', async () => {
    const n = await runIndexPass(db, fakeProvider);
    expect(n).toBe(2);
    const ids = db
      .prepare(`SELECT doc_id FROM ${MESSAGE_VECTORS} ORDER BY doc_id`)
      .all()
      .map((r) => (r as { doc_id: string }).doc_id);
    expect(ids).toEqual(['a1', 'u1']);
    // the indexer hands raw content to the provider (prefixing is the provider's job)
    expect(embedded.sort()).toEqual(['a reply', 'hello world']);
  });

  it('is idempotent — a second pass embeds nothing new', async () => {
    const before = vectorRowCount(db, MESSAGE_VECTORS);
    const n = await runIndexPass(db, fakeProvider);
    expect(n).toBe(0);
    expect(vectorRowCount(db, MESSAGE_VECTORS)).toBe(before);
  });

  it('picks up a newly added message on the next pass', async () => {
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,created_at) VALUES ('u2','is','user','new msg','6')",
    ).run();
    const n = await runIndexPass(db, fakeProvider);
    expect(n).toBe(1);
    expect(
      db.prepare(`SELECT 1 FROM ${MESSAGE_VECTORS} WHERE doc_id='u2'`).get(),
    ).toBeTruthy();
  });

  it('indexOneBatch respects the limit', async () => {
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,created_at) VALUES ('b1','is','user','x','7'),('b2','is','user','y','8'),('b3','is','user','z','9')",
    ).run();
    const n = await indexOneBatch(db, fakeProvider, 2);
    expect(n).toBe(2);
  });
});

describe.skipIf(!available)('backfillMessageIndexState (migration 40)', () => {
  it('seeds state from pre-existing vectors so they are not re-embedded', () => {
    // Simulate a pre-migration install: vectors exist, but the state table is empty.
    db.exec(`DELETE FROM ${MESSAGE_VECTORS}; DELETE FROM message_index_state;`);
    upsertVector(db, MESSAGE_VECTORS, 'x1', new Float32Array(4));
    upsertVector(db, MESSAGE_VECTORS, 'x2', new Float32Array(4));

    expect(backfillMessageIndexState(db)).toBe(2);
    const ids = db
      .prepare('SELECT doc_id FROM message_index_state ORDER BY doc_id')
      .all()
      .map((r) => (r as { doc_id: string }).doc_id);
    expect(ids).toEqual(['x1', 'x2']);

    // idempotent: state is no longer empty, so a re-run seeds nothing.
    expect(backfillMessageIndexState(db)).toBe(0);
  });
});
