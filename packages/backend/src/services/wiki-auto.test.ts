import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { pickAutoAnalyzeTarget } from './wiki-auto.js';

const db = getDb();
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0); // fixed "now" in ms
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

function seedProject(id: string, opts: { wikiAuto?: boolean } = {}) {
  db.prepare(
    'INSERT INTO projects (id,name,cwd,wiki_auto,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, id.toUpperCase(), `/tmp/${id}`, opts.wikiAuto === false ? 0 : 1, 't', 't');
  db.prepare('INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    `s-${id}`,
    id,
    'S',
    't',
    't',
  );
}
function seedMessages(projectId: string, n: number, createdAt: string) {
  const stmt = db.prepare(
    'INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < n; i++) stmt.run(`m-${projectId}-${i}`, `s-${projectId}`, 'user', 'work', createdAt);
}

describe('pickAutoAnalyzeTarget', () => {
  beforeEach(() => {
    db.exec(
      "DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects; DELETE FROM wiki_analyze_state; DELETE FROM wiki_proposals;",
    );
  });
  afterEach(() => {
    db.exec(
      "DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects; DELETE FROM wiki_analyze_state; DELETE FROM wiki_proposals;",
    );
  });

  it('picks an idle project with ≥ DELTA new messages and no prior run', () => {
    seedProject('p1');
    seedMessages('p1', 25, iso(2 * HOUR)); // 2h ago → idle, 25 ≥ DELTA(20)
    const t = pickAutoAnalyzeTarget(db, NOW);
    expect(t?.projectId).toBe('p1');
    expect(t?.newSince).toBe(25);
  });

  it('skips a mid-conversation project (recent activity)', () => {
    seedProject('p1');
    seedMessages('p1', 25, iso(60_000)); // 1 min ago → not idle
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull();
  });

  it('skips when fewer than DELTA new messages', () => {
    seedProject('p1');
    seedMessages('p1', 5, iso(2 * HOUR));
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull();
  });

  it('skips wiki_auto=0 projects', () => {
    seedProject('p1', { wikiAuto: false });
    seedMessages('p1', 25, iso(2 * HOUR));
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull();
  });

  it('respects the min interval since last run', () => {
    seedProject('p1');
    seedMessages('p1', 25, iso(2 * HOUR));
    db.prepare('INSERT INTO wiki_analyze_state (project_id,last_run_at) VALUES (?,?)').run(
      'p1',
      iso(1 * HOUR), // ran 1h ago → < 24h, too soon
    );
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull();
  });

  it('only counts messages newer than the last run (delta cursor)', () => {
    seedProject('p1');
    seedMessages('p1', 25, iso(30 * HOUR)); // older than a day-ago run
    db.prepare('INSERT INTO wiki_analyze_state (project_id,last_run_at) VALUES (?,?)').run(
      'p1',
      iso(26 * HOUR), // >24h ago (interval ok), but newer than the messages
    );
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull(); // 0 new since last run
  });

  it('skips when a pending proposal already exists for the conventions page', () => {
    seedProject('p1');
    seedMessages('p1', 25, iso(2 * HOUR));
    const relPath = `conventions-${getProjectWikiSlugByProjectId('p1')}.md`;
    db.prepare(
      "INSERT INTO wiki_proposals (id,kind,status,title,rel_path,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run('pp', 'replace_page', 'pending', 'x', relPath, '{}', 't', 't');
    expect(pickAutoAnalyzeTarget(db, NOW)).toBeNull();
  });

  it('picks the project with the most new messages', () => {
    seedProject('p1');
    seedProject('p2');
    seedMessages('p1', 25, iso(2 * HOUR));
    seedMessages('p2', 40, iso(2 * HOUR));
    expect(pickAutoAnalyzeTarget(db, NOW)?.projectId).toBe('p2');
  });
});
