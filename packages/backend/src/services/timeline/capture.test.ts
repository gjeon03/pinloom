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
// Long enough to clear the substantive-delta floor (>= 80 chars).
const LONG =
  '오늘은 빌링 마이그레이션 작업을 진행했고 결제 라우팅 분리 방식을 결정했다. 후속으로 통합 테스트를 추가할 예정이고, 인덱싱 파이프라인의 재시작 안전성도 함께 점검했다. 추가로 문서도 갱신했다.';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-cap-'));
  reset();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sweep = (extra = {}) =>
  runCaptureSweep(db, { now: NOW, home, runDistill: fakeDistill, isBusy: () => false, ...extra });

describe('runCaptureSweep', () => {
  it('writes an entry for an idle session with new work + advances the cursor', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', LONG, idleAt);
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
    addMsg('m1', 's1', 'user', LONG, recentAt);
    expect(await sweep()).toBe(0);
  });

  it('skips a session that is mid-turn (isRunning)', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', LONG, idleAt);
    expect(await sweep({ isBusy: () => true })).toBe(0);
  });

  it('skips a project with auto-capture OFF', async () => {
    seedProject('p1', false);
    seedSession('s1', 'p1');
    addMsg('m1', 's1', 'user', LONG, idleAt);
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

  it('splits a cross-midnight session into one entry per local day (no drop)', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60_000).toISOString();
    addMsg('d1', 's1', 'user', LONG, twoDaysAgo); // earlier day
    addMsg('d2', 's1', 'assistant', LONG, idleAt); // later day (idle)
    const n = await sweep();
    expect(n).toBe(2); // an entry for EACH day
    const slug = getProjectWikiSlugByProjectId('p1');
    expect(readEntry(slug, localDateOf(twoDaysAgo), home)).toContain('captured');
    expect(readEntry(slug, localDateOf(idleAt), home)).toContain('captured');
    // cursor advanced to the latest day's message (processed ascending)
    const cur = db
      .prepare('SELECT last_captured_message_id AS id FROM timeline_capture_state WHERE session_id=?')
      .get('s1') as { id: string };
    expect(cur.id).toBe('d2');
  });

  it('caps a giant message before it reaches the distiller (anti-bloat)', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    addMsg('big', 's1', 'user', 'X'.repeat(5000), idleAt);
    let seenPrompt = '';
    const recordDistill: RunDistill = async (prompt) => ((seenPrompt = prompt), '# entry\n- ok');
    await runCaptureSweep(db, { now: NOW, home, runDistill: recordDistill, isBusy: () => false });
    expect(seenPrompt).toContain('…(생략)'); // capped marker present
    const longestRun = Math.max(...[...seenPrompt.matchAll(/X+/g)].map((m) => m[0].length), 0);
    expect(longestRun).toBeLessThanOrEqual(1500); // not the full 5000
  });

  it('captures multiple sessions of one project into one project-day entry', async () => {
    seedProject('p1');
    seedSession('s1', 'p1');
    seedSession('s2', 'p1');
    addMsg('m1', 's1', 'user', LONG, idleAt);
    addMsg('m2', 's2', 'assistant', LONG, idleAt);
    const n = await sweep();
    expect(n).toBe(1); // one entry for the project-day, both sessions folded in
    // both cursors advanced
    const cnt = db.prepare('SELECT COUNT(*) c FROM timeline_capture_state').get() as { c: number };
    expect(cnt.c).toBe(2);
  });
});
