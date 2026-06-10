import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { getStopHookServer, shutdownStopHookServer } from './shared-server.js';
import { startCapture, stopCapture } from './transcript-capture.js';

afterAll(async () => {
  await shutdownStopHookServer();
});

let projSeq = 0;
function insertSession(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const projId = `proj-cap-${projSeq++}`;
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(projId, 'cap', `/tmp/cap-${projId}`, now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, agent, transport, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, projId, 'claude', 'terminal', now, now);
}

function writeTranscript(file: string, lines: object[]): void {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
}

async function fireStop(pinloomSessionId: string, transcriptPath: string, claudeSid: string) {
  const server = await getStopHookServer();
  await fetch(server.url(), {
    method: 'POST',
    body: JSON.stringify({
      session_id: claudeSid,
      pinloom_session_id: pinloomSessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
    }),
  });
  // capture runs async off the POST; give it a beat to persist.
  await new Promise((r) => setTimeout(r, 200));
}

function rows(sid: string) {
  return getDb()
    .prepare(
      'SELECT role, content, transcript_uuid FROM messages WHERE session_id=? ORDER BY rowid ASC',
    )
    .all(sid) as { role: string; content: string; transcript_uuid: string | null }[];
}

describe('transcript capture', () => {
  it('persists user + assistant + tool rows from a turn on Stop, advances cursor + agent id', async () => {
    const sid = 'sess-cap-1';
    insertSession(sid);
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-'));
    const tfile = path.join(dir, 'claude-x.jsonl');
    writeTranscript(tfile, [
      { type: 'system', uuid: 'boot' },
      { type: 'user', uuid: 'u1', parentUuid: 'boot', message: { role: 'user', content: 'hello there' } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [
            { type: 'text', text: 'hi back' },
            { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    ]);

    await startCapture(sid, null);
    await fireStop(sid, tfile, 'claude-x');

    const r = rows(sid);
    const byRole = (role: string) => r.find((x) => x.role === role);
    expect(byRole('user')?.content).toBe('hello there');
    expect(byRole('assistant')?.content).toBe('hi back');
    expect(byRole('tool')?.content).toBe('Bash: ls');
    expect(byRole('assistant')?.transcript_uuid).toBe('a1');

    const cur = getDb()
      .prepare('SELECT last_captured_transcript_uuid AS c, agent_session_id AS a FROM sessions WHERE id=?')
      .get(sid) as { c: string | null; a: string | null };
    expect(cur.c).toBe('a1');
    expect(cur.a).toBe('claude-x');

    stopCapture(sid);
  });

  it('does not re-capture already-folded lines on a repeat Stop, but captures a new turn', async () => {
    const sid = 'sess-cap-2';
    insertSession(sid);
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-'));
    const tfile = path.join(dir, 'claude-y.jsonl');
    const turn1 = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'first' }] } },
    ];
    writeTranscript(tfile, turn1);

    await startCapture(sid, null);
    await fireStop(sid, tfile, 'claude-y');
    expect(rows(sid).length).toBe(2);

    // repeat Stop, same transcript — no new rows
    await fireStop(sid, tfile, 'claude-y');
    expect(rows(sid).length).toBe(2);

    // a new turn appended — captured
    writeTranscript(tfile, [
      ...turn1,
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'second' }] } },
    ]);
    await fireStop(sid, tfile, 'claude-y');
    const r = rows(sid);
    expect(r.length).toBe(4);
    expect(r.map((x) => x.content)).toEqual(['one', 'first', 'two', 'second']);

    stopCapture(sid);
  });
});
