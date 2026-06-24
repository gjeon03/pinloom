import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import {
  listRecentSessions,
  readSessionTranscript,
} from './session-transcript.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'Proj One', '/tmp/p1', 't', 't');
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('s1', 'p1', 'Session 1', 't', 't');
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
  sourceMessageId: string | null = null,
) {
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, source_message_id, created_at) VALUES (?,?,?,?,?,?)',
  ).run(id, sessionId, role, content, sourceMessageId, createdAt);
}

describe('readSessionTranscript', () => {
  it('returns null for an unknown session', () => {
    expect(readSessionTranscript('nope', { db })).toBeNull();
  });

  it('renders user/assistant/tool rows in chronological order', () => {
    addMsg('m1', 's1', 'user', 'hello', '2026-06-23T01:00:00Z');
    addMsg('m2', 's1', 'assistant', 'hi there', '2026-06-23T01:00:01Z');
    addMsg('m3', 's1', 'tool', '$ Edit: a.ts (edit)', '2026-06-23T01:00:02Z');
    const r = readSessionTranscript('s1', { db });
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Session 1');
    expect(r!.projectName).toBe('Proj One');
    expect(r!.totalMessages).toBe(3);
    expect(r!.includedMessages).toBe(3);
    expect(r!.truncated).toBe(false);
    // order: user, assistant, tool
    expect(r!.text.indexOf('[user]')).toBeLessThan(r!.text.indexOf('[assistant]'));
    expect(r!.text.indexOf('[assistant]')).toBeLessThan(r!.text.indexOf('[tool]'));
    expect(r!.text).toContain('$ Edit: a.ts (edit)');
  });

  it('skips worker-mirror rows (source_message_id set) and system rows', () => {
    addMsg('m1', 's1', 'user', 'real', '1');
    addMsg('m2', 's1', 'assistant', 'mirror', '2', 'orig-1');
    addMsg('m3', 's1', 'system', '[cancelled by user]', '3');
    const r = readSessionTranscript('s1', { db })!;
    expect(r.totalMessages).toBe(1);
    expect(r.text).toContain('real');
    expect(r.text).not.toContain('mirror');
    expect(r.text).not.toContain('cancelled');
  });

  it('keeps the most recent messages when over the count limit, marking truncated', () => {
    for (let i = 0; i < 10; i++) {
      addMsg(`m${i}`, 's1', 'user', `msg-${i}`, `2026-06-23T01:00:0${i}Z`);
    }
    const r = readSessionTranscript('s1', { db, limit: 3 })!;
    expect(r.includedMessages).toBe(3);
    expect(r.truncated).toBe(true);
    // newest three kept: msg-7, msg-8, msg-9
    expect(r.text).toContain('msg-9');
    expect(r.text).toContain('msg-7');
    expect(r.text).not.toContain('msg-6');
  });
});

describe('listRecentSessions', () => {
  it('lists non-bot sessions newest-first with message counts', () => {
    db.prepare(
      'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('s2', 'p1', 'Session 2', 't', '2026-06-23T05:00:00Z');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
      '2026-06-23T02:00:00Z',
      's1',
    );
    addMsg('m1', 's1', 'user', 'a', '1');
    addMsg('m2', 's1', 'assistant', 'b', '2');
    const list = listRecentSessions({ db });
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
    const s1 = list.find((s) => s.id === 's1')!;
    expect(s1.messageCount).toBe(2);
    expect(s1.projectName).toBe('Proj One');
  });

  it('excludes bot sessions', () => {
    db.prepare(
      'INSERT INTO sessions (id, project_id, title, bot_kind, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('bot1', 'p1', '일정 봇', 'schedule', 't', 't');
    const list = listRecentSessions({ db });
    expect(list.map((s) => s.id)).not.toContain('bot1');
  });
});
