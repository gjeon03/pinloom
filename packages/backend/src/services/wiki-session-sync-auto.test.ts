import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import { pickSessionSyncTarget } from './wiki-session-sync-auto.js';

const db = getDb();
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

function reset() {
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects; DELETE FROM wiki_proposals;');
}

function seedProject(id: string, opts: { wikiAuto?: boolean } = {}) {
  db.prepare(
    'INSERT INTO projects (id,name,cwd,wiki_auto,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, id, `/tmp/${id}`, opts.wikiAuto === false ? 0 : 1, 't', 't');
}
function seedSession(
  sid: string,
  projectId: string,
  opts: { botKind?: string; cursor?: string } = {},
) {
  db.prepare(
    'INSERT INTO sessions (id,project_id,title,bot_kind,last_synced_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(sid, projectId, 'S', opts.botKind ?? null, opts.cursor ?? null, 't', 't');
}
function seedMessages(sid: string, n: number, createdAt: string, prefix = 'm') {
  const stmt = db.prepare(
    'INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < n; i++) stmt.run(`${prefix}-${sid}-${i}`, sid, 'user', 'work', createdAt);
}

describe('pickSessionSyncTarget', () => {
  beforeEach(reset);
  afterEach(reset);

  it('picks an idle session with ≥ DELTA(30) unsynced messages', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedMessages('s1', 35, iso(2 * HOUR)); // idle (2h) + 35 ≥ 30
    const t = pickSessionSyncTarget(db, NOW);
    expect(t?.sessionId).toBe('s1');
    expect(t?.unsynced).toBe(35);
  });

  it('skips a mid-conversation session (recent activity)', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedMessages('s1', 35, iso(60_000)); // 1 min ago → active
    expect(pickSessionSyncTarget(db, NOW)).toBeNull();
  });

  it('skips when fewer than DELTA unsynced', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedMessages('s1', 10, iso(2 * HOUR));
    expect(pickSessionSyncTarget(db, NOW)).toBeNull();
  });

  it('skips wiki_auto=0 projects', () => {
    seedProject('p1', { wikiAuto: false });
    seedSession('s1', 'p1');
    seedMessages('s1', 35, iso(2 * HOUR));
    expect(pickSessionSyncTarget(db, NOW)).toBeNull();
  });

  it('skips bot sessions', () => {
    seedProject('p1');
    seedSession('s1', 'p1', { botKind: 'skill' });
    seedMessages('s1', 35, iso(2 * HOUR));
    expect(pickSessionSyncTarget(db, NOW)).toBeNull();
  });

  it('only counts messages AFTER the synced cursor', () => {
    seedProject('p1');
    // cursor = 'old-s1-39' (created at 3h ago); older batch shares that time and
    // isn't counted (strict >), the 35 newer messages are.
    seedSession('s1', 'p1', { cursor: 'old-s1-39' });
    seedMessages('s1', 40, iso(3 * HOUR), 'old'); // synced batch (== cursor time)
    seedMessages('s1', 35, iso(2 * HOUR), 'new'); // 35 unsynced (later)
    const t = pickSessionSyncTarget(db, NOW);
    expect(t?.sessionId).toBe('s1');
    expect(t?.unsynced).toBe(35);
  });

  it('respects the exclude set (in-flight / recently attempted)', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedMessages('s1', 35, iso(2 * HOUR));
    expect(pickSessionSyncTarget(db, NOW, new Set(['s1']))).toBeNull();
  });

  it('skips a session with an unreviewed pending sync proposal', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedMessages('s1', 35, iso(2 * HOUR));
    db.prepare(
      'INSERT INTO wiki_proposals (id,kind,status,title,rel_path,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('wp1', 'replace_page', 'pending', 'Sync', 'domain-p1.md', JSON.stringify({ sessionId: 's1' }), 't', 't');
    expect(pickSessionSyncTarget(db, NOW)).toBeNull();
  });

  it('picks the session with the most unsynced when several are eligible', () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedSession('s2', 'p1');
    seedMessages('s1', 31, iso(2 * HOUR));
    seedMessages('s2', 50, iso(2 * HOUR));
    expect(pickSessionSyncTarget(db, NOW)?.sessionId).toBe('s2');
  });
});
