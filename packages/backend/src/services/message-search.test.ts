import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import {
  buildExcerpt,
  searchMessages,
  tokenizeQuery,
  toLikeParam,
  toMatchExpr,
} from './message-search.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'Proj One', '/tmp/p1', 't', 't');
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p2', 'Proj Two', '/tmp/p2', 't', 't');
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('s1', 'p1', 'Session 1', 't', 't');
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('s2', 'p2', 'Session 2', 't', 't');
});

afterEach(() => {
  db.close();
});

function addMsg(
  id: string,
  sessionId: string,
  role: string,
  content: string,
  createdAt = id,
) {
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)',
  ).run(id, sessionId, role, content, createdAt);
}

describe('tokenizeQuery', () => {
  it('splits into >=3-char MATCH tokens and 1-2-char LIKE tokens', () => {
    expect(tokenizeQuery('배포 deploy 인증')).toEqual({
      matchTokens: ['deploy'],
      likeTokens: ['배포', '인증'],
    });
  });
  it('treats a 3-syllable Korean term as a MATCH token', () => {
    expect(tokenizeQuery('파이프라인').matchTokens).toEqual(['파이프라인']);
  });
  it('collapses extra whitespace and ignores empties', () => {
    expect(tokenizeQuery('  a   bbb  ')).toEqual({
      matchTokens: ['bbb'],
      likeTokens: ['a'],
    });
  });
});

describe('toMatchExpr / toLikeParam', () => {
  it('quotes each token as a phrase and ANDs them', () => {
    expect(toMatchExpr(['foo', 'bar'])).toBe('"foo" "bar"');
  });
  it('escapes embedded double-quotes (no FTS injection)', () => {
    expect(toMatchExpr(['a"b'])).toBe('"a""b"');
  });
  it('escapes LIKE wildcards', () => {
    expect(toLikeParam('50%_x')).toBe('%50\\%\\_x%');
  });
});

describe('buildExcerpt', () => {
  it('windows around the first match with ellipses and highlight ranges', () => {
    const long = `${'x'.repeat(100)} deploy ${'y'.repeat(200)}`;
    const { excerpt, highlights } = buildExcerpt(long, ['deploy']);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('deploy');
    const [s, e] = highlights[0];
    expect(excerpt.slice(s, e)).toBe('deploy');
  });
  it('merges overlapping highlight ranges from different tokens', () => {
    // 'abc' → [0,3], 'bcd' → [1,4]; overlapping → merged to [0,4]
    const { highlights } = buildExcerpt('abcd', ['abc', 'bcd']);
    expect(highlights).toEqual([[0, 4]]);
  });
});

describe('searchMessages', () => {
  it('returns [] for an empty query', () => {
    addMsg('m1', 's1', 'user', 'deploy pipeline');
    expect(searchMessages(db, '   ')).toEqual([]);
  });

  it('finds a >=3-char English term via MATCH', () => {
    addMsg('m1', 's1', 'user', 'deploy the pipeline now');
    addMsg('m2', 's1', 'assistant', 'unrelated content');
    const r = searchMessages(db, 'deploy');
    expect(r.map((x) => x.messageId)).toEqual(['m1']);
    expect(r[0].sessionTitle).toBe('Session 1');
    expect(r[0].projectName).toBe('Proj One');
  });

  it('finds a 2-syllable Korean term via the base-table LIKE fallback', () => {
    addMsg('m1', 's1', 'user', '배포 했다');
    addMsg('m2', 's1', 'assistant', '인증 토큰');
    expect(searchMessages(db, '배포').map((x) => x.messageId)).toEqual(['m1']);
    expect(searchMessages(db, '인증').map((x) => x.messageId)).toEqual(['m2']);
  });

  it('never surfaces tool rows or empty rows (not indexed, role-filtered)', () => {
    addMsg('m1', 's1', 'user', '배포 작업');
    addMsg('m2', 's1', 'tool', '배포 tool noise should not surface');
    addMsg('m3', 's1', 'assistant', ''); // empty placeholder
    // 2-char LIKE path
    expect(searchMessages(db, '배포').map((x) => x.messageId)).toEqual(['m1']);
    // >=3-char MATCH path also excludes the tool row
    addMsg('m4', 's1', 'tool', 'deploy noise');
    addMsg('m5', 's1', 'user', 'deploy real');
    expect(searchMessages(db, 'deploy').map((x) => x.messageId)).toEqual(['m5']);
  });

  it('ANDs a >=3-char MATCH token with a 1-2-char LIKE token', () => {
    addMsg('m1', 's1', 'user', 'deploy 배포 done');
    addMsg('m2', 's1', 'user', 'deploy only english');
    expect(searchMessages(db, 'deploy 배포').map((x) => x.messageId)).toEqual([
      'm1',
    ]);
  });

  it('scopes to a project when projectId is given', () => {
    addMsg('m1', 's1', 'user', 'shared deploy term');
    addMsg('m2', 's2', 'user', 'shared deploy term');
    expect(
      searchMessages(db, 'deploy', { projectId: 'p1' }).map((x) => x.messageId),
    ).toEqual(['m1']);
    expect(searchMessages(db, 'deploy').length).toBe(2);
  });

  it('indexes content written by a later streaming UPDATE, not the empty placeholder', () => {
    // persistMessage creates an empty row; runner UPDATEs content on flush.
    addMsg('m1', 's1', 'assistant', '');
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
      'streamed deploy answer',
      'm1',
    );
    expect(searchMessages(db, 'deploy').map((x) => x.messageId)).toEqual(['m1']);
  });

  it('drops results and keeps the index consistent after a cascade session delete', () => {
    addMsg('m1', 's1', 'user', 'deploy 배포');
    expect(searchMessages(db, 'deploy').length).toBe(1);

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1'); // cascade → messages

    expect(searchMessages(db, 'deploy')).toEqual([]);
    expect(searchMessages(db, '배포')).toEqual([]);
    // The external-content index must remain valid (no orphaned terms).
    expect(() =>
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')"),
    ).not.toThrow();
  });

  it('does not throw on queries containing FTS5 operators (no injection)', () => {
    addMsg('m1', 's1', 'user', 'deploy AND release OR rollback');
    expect(() => searchMessages(db, 'AND OR NEAR(')).not.toThrow();
    // the operators are matched as literal phrases
    expect(searchMessages(db, 'rollback').map((x) => x.messageId)).toEqual([
      'm1',
    ]);
  });
});

// The real-user upgrade path: rows already exist when migration 29 runs and
// the index is built by the backfill, NOT the triggers. A naive FTS5 'rebuild'
// would index tool/empty rows and corrupt the index once they're deleted; the
// guarded INSERT...SELECT backfill must mirror the trigger filter exactly.
describe('migration 29 backfill over pre-existing history', () => {
  function migrationSql(id: number): string {
    const m = MIGRATIONS.find((x) => x.id === id);
    if (!m) throw new Error(`migration ${id} not found`);
    return m.sql;
  }

  it('backfills only user/assistant non-empty rows and stays consistent on delete', () => {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    // Apply the schema up to but excluding the FTS migration.
    for (const m of MIGRATIONS) if (m.id < 29) d.exec(m.sql);
    // Seed history BEFORE the FTS exists (so only the backfill can index it).
    d.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('p1', 'P', '/tmp/bf', 't', 't');
    d.prepare(
      'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('s1', 'p1', 'S', 't', 't');
    const seed = d.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)',
    );
    seed.run('u1', 's1', 'user', 'pre-existing deploy 배포', '1');
    seed.run('t1', 's1', 'tool', 'pre-existing deploy tool noise 배포', '2');
    seed.run('e1', 's1', 'assistant', '', '3');

    // Now run the FTS migration (creates the vtable + triggers + backfill).
    d.exec(migrationSql(29));

    // Only the user row is searchable; the tool/empty rows were never indexed.
    expect(searchMessages(d, 'deploy').map((r) => r.messageId)).toEqual(['u1']);
    expect(searchMessages(d, '배포').map((r) => r.messageId)).toEqual(['u1']);

    // Deleting the never-indexed tool row must not leave a stale entry.
    d.prepare('DELETE FROM messages WHERE id = ?').run('t1');
    expect(() =>
      d.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')"),
    ).not.toThrow();
    expect(searchMessages(d, 'deploy').map((r) => r.messageId)).toEqual(['u1']);

    d.close();
  });
});
