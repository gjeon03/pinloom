import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { getProjectWikiSlugByProjectId } from '../wiki-sync.js';
import { __resetTimelineCaptureForTest, localDateOf, runCaptureSweep } from './capture.js';
import { readEntry } from './store.js';
import type { RunDistill } from './distill.js';

const db = getDb();
let home: string;
const NOW = Date.parse('2026-06-24T12:00:00Z');
const fakeDistill: RunDistill = async () => '# entry\n\n## 한 일\n- captured';

function reset() {
  db.exec('DELETE FROM timeline_capture_state');
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM projects');
  __resetTimelineCaptureForTest();
}

function seedProject(id: string, autoOn = true) {
  db.prepare(
    'INSERT INTO projects (id,name,cwd,timeline_auto,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, id.toUpperCase(), `/tmp/${id}`, autoOn ? 1 : 0, 't', 't');
}
function seedSession(id: string, projectId: string) {
  db.prepare(
    'INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run(id, projectId, 'S', 't', 't');
}
function addMsg(id: string, sessionId: string, role: string, content: string, createdAt: string) {
  db.prepare(
    'INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)',
  ).run(id, sessionId, role, content, createdAt);
}
const idleAt = new Date(NOW - 20 * 60_000).toISOString(); // 20 min ago → idle
const recentAt = new Date(NOW - 5 * 60_000).toISOString(); // 5 min ago → not idle

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-cap-'));
  reset();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sweep = (extra = {}) =>
  runCaptureSweep(db, { now: NOW, home, runDistill: fakeDistill, isRunning: () => false, ...extra });

describe('runCaptureSweep', () => {
  it('writes an entry for an idle session with new work + advances the cursor', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', '빌링 작업 하자', idleAt);
    const n = await sweep();
    expect(n).toBe(1);
    const date = localDateOf(idleAt);
    const slug = getProjectWikiSlugByProjectId('p1');
    expect(readEntry(slug, date, home)).toContain('captured');
    // cursor advanced → a second sweep does nothing
    const n2 = await sweep();
    expect(n2).toBe(0);
  });

  it('skips a session that is not idle yet', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', 'still working', recentAt);
    expect(await sweep()).toBe(0);
  });

  it('skips a session that is mid-turn (isRunning)', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', 'working', idleAt);
    expect(await sweep({ isRunning: () => true })).toBe(0);
  });

  it('skips a project with auto-capture OFF', async () => {
    seedProject('p1', false);
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', 'working', idleAt);
    expect(await sweep()).toBe(0);
  });

  it('ignores empty/tool/mirror messages (no substantive content → nothing)', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('e', 's1', 'assistant', '', idleAt); // placeholder
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,source_message_id,created_at) VALUES ('mir','s1','assistant','x','orig',?)",
    ).run(idleAt);
    expect(await sweep()).toBe(0);
  });

  it('captures multiple sessions of one project into one project-day entry', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedSession('s2', 'p1');
    addMsg('m1', 's1', 'user', 'frontend work', idleAt);
    addMsg('m2', 's2', 'assistant', 'backend work', idleAt);
    const n = await sweep();
    expect(n).toBe(1); // one entry for the project-day, both sessions folded in
    // both cursors advanced
    const cnt = db.prepare('SELECT COUNT(*) c FROM timeline_capture_state').get() as { c: number };
    expect(cnt.c).toBe(2);
  });
});
