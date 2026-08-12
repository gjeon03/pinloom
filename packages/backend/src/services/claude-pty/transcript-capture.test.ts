import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WsEvent } from '@pinloom/shared';
import { getDb } from '../../db/connection.js';
import * as hub from '../../ws/hub.js';
import { getStopHookServer, shutdownStopHookServer } from './shared-server.js';
import { sessionFilePath } from './transcript.js';
import { persistMessage } from '../runner.js';
import { startCapture, stopCapture, linkClaudeSessionId } from './transcript-capture.js';

// Catch-up tests write transcripts to the real `sessionFilePath` location (under
// ~/.claude/projects/<slug>/), since that's the path startCapture derives. The
// slug comes from the test's unique /tmp cwd so it never collides with real
// projects; clean the dirs up afterwards.
const transcriptDirsToClean: string[] = [];

afterAll(async () => {
  await shutdownStopHookServer();
  for (const d of transcriptDirsToClean) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cwdOf(sid: string): string {
  return (
    getDb()
      .prepare('SELECT p.cwd AS cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
      .get(sid) as { cwd: string }
  ).cwd;
}

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
  const body = lines.map((line) => JSON.stringify(line)).join('\n');
  writeFileSync(file, body ? `${body}\n` : '', 'utf8');
}

function appendTranscript(file: string, lines: object[]): void {
  const body = lines.map((line) => JSON.stringify(line)).join('\n');
  if (body) appendFileSync(file, `${body}\n`, 'utf8');
}

function userLine(uuid: string, content: string, parentUuid: string | null = null) {
  return {
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content },
  };
}

function assistantLine(uuid: string, content: string, parentUuid: string | null) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: content }],
    },
  };
}

function captureState(sid: string) {
  return getDb()
    .prepare(
      `SELECT transcript_identity AS transcriptIdentity,
              complete_offset AS completeOffset,
              last_transcript_uuid AS lastTranscriptUuid,
              last_conversation_type AS lastConversationType
       FROM claude_transcript_state
       WHERE session_id = ?`,
    )
    .get(sid) as
    | {
        transcriptIdentity: string;
        completeOffset: number;
        lastTranscriptUuid: string | null;
        lastConversationType: string | null;
      }
    | undefined;
}

function captureEvents() {
  const events: WsEvent[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => events.push(JSON.parse(payload) as WsEvent),
  };
  return { events, socket: socket as unknown as Parameters<typeof hub.subscribe>[1] };
}

async function postStop(
  pinloomSessionId: string,
  transcriptPath: string,
  claudeSid: string,
  lastAssistantMessage?: string,
) {
  const server = await getStopHookServer();
  await fetch(server.url(), {
    method: 'POST',
    body: JSON.stringify({
      session_id: claudeSid,
      pinloom_session_id: pinloomSessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      ...(lastAssistantMessage ? { last_assistant_message: lastAssistantMessage } : {}),
    }),
  });
}

async function fireStop(pinloomSessionId: string, transcriptPath: string, claudeSid: string) {
  await postStop(pinloomSessionId, transcriptPath, claudeSid);
  // capture runs async off the POST; give it a beat to persist.
  await new Promise((r) => setTimeout(r, 200));
}

async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
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

  // Capture must link and fold even when no Stop hook fires, driven by
  // out-of-band filesystem discovery instead.
  it('linkClaudeSessionId records the id + folds the transcript with no Stop hook', async () => {
    const sid = 'sess-cap-link';
    insertSession(sid);
    const claudeSid = 'claude-link-1';
    const tfile = sessionFilePath(cwdOf(sid), claudeSid);
    mkdirSync(path.dirname(tfile), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tfile));
    writeTranscript(tfile, [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'world' }] },
      },
    ]);

    await startCapture(sid, null); // fresh — no resume token, exactly the failing app case
    linkClaudeSessionId(sid, claudeSid); // synchronous fold

    const r = rows(sid);
    expect(r.find((x) => x.role === 'user')?.content).toBe('hello');
    expect(r.find((x) => x.role === 'assistant')?.content).toBe('world');
    const cur = getDb()
      .prepare('SELECT claude_session_id AS c, agent_session_id AS a FROM sessions WHERE id=?')
      .get(sid) as { c: string | null; a: string | null };
    expect(cur.c).toBe(claudeSid);
    expect(cur.a).toBe(claudeSid);

    // idempotent: re-linking the same id doesn't double-fold
    linkClaudeSessionId(sid, claudeSid);
    expect(rows(sid).length).toBe(2);

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

  it('captures a late-flushing assistant reply via the rescan tail (no next turn)', async () => {
    // Regression: claude fires the Stop hook a beat BEFORE it flushes the
    // completed assistant message to the transcript. If the flush is slower than
    // the in-handler poll, the old code persisted only the user line and the
    // reply went missing until the NEXT turn's Stop (symptom: history/pins panel
    // stopped at the user message). A captured user line with no reply yet is
    // itself the signal that a reply is coming, so the rescan tail must pick it
    // up on its own — WITHOUT relying on any Stop-payload field.
    const sid = 'sess-cap-late';
    insertSession(sid);
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-'));
    const tfile = path.join(dir, 'claude-late.jsonl');

    // Only the user line has flushed when the Stop hook fires.
    const userLine = {
      type: 'user',
      uuid: 'lu1',
      parentUuid: null,
      message: { role: 'user', content: 'hey there' },
    };
    writeTranscript(tfile, [userLine]);

    await startCapture(sid, null);
    // Fire WITHOUT last_assistant_message — capture must infer "reply coming"
    // from the unmatched user line alone (the real Stop hook omits the field).
    await postStop(sid, tfile, 'claude-late');

    // The user line lands first (in-handler poll finds no assistant, persists the
    // user row, then schedules the rescan tail).
    await until(() => rows(sid).some((x) => x.role === 'user'));
    expect(rows(sid).some((x) => x.role === 'assistant')).toBe(false);

    // The assistant reply flushes LATE — append it now, after the Stop already
    // fired and the user row is in.
    writeTranscript(tfile, [
      userLine,
      {
        type: 'assistant',
        uuid: 'la1',
        parentUuid: 'lu1',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'hey back, friend' }],
        },
      },
    ]);

    // Rescan tail catches it without any further Stop / user turn.
    await until(() => rows(sid).some((x) => x.role === 'assistant'));
    const r = rows(sid);
    expect(r.map((x) => x.content)).toEqual(['hey there', 'hey back, friend']);
    expect(r.find((x) => x.role === 'assistant')?.transcript_uuid).toBe('la1');

    // Cursor advanced to the assistant line so a later Stop won't re-capture it.
    const cur = getDb()
      .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id=?')
      .get(sid) as { c: string | null };
    expect(cur.c).toBe('la1');

    stopCapture(sid);
  });

  it('rescan chases past an intermediate reply until the latest user line is answered', async () => {
    // Regression for "only the newest reply goes missing": while a rescan chases
    // turn A's reply, turn B's Stop can be dropped by the re-entrancy guard. If
    // the rescan terminated as soon as it saw ANY assistant text (turn A's), turn
    // B's reply would be orphaned until the next turn. The rescan must instead
    // keep going until the transcript TAIL is a reply — i.e. no user line is left
    // dangling.
    const sid = 'sess-cap-dangle';
    insertSession(sid);
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-'));
    const tfile = path.join(dir, 'claude-dangle.jsonl');

    const uA = { type: 'user', uuid: 'duA', parentUuid: null, message: { role: 'user', content: 'A?' } };
    const aA = { type: 'assistant', uuid: 'daA', parentUuid: 'duA', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'A!' }] } };
    const uB = { type: 'user', uuid: 'duB', parentUuid: 'daA', message: { role: 'user', content: 'B?' } };
    const aB = { type: 'assistant', uuid: 'daB', parentUuid: 'duB', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'B!' }] } };

    writeTranscript(tfile, [uA]);
    await startCapture(sid, null);
    await postStop(sid, tfile, 'claude-dangle');
    await until(() => rows(sid).some((x) => x.content === 'A?'));

    // A's reply lands AND B's prompt arrives — the tail is now a USER line.
    writeTranscript(tfile, [uA, aA, uB]);
    await until(() => rows(sid).some((x) => x.content === 'B?'));
    // The rescan saw an assistant line (A!) but must NOT have stopped: B is still
    // unanswered, so B!'s slot is empty and the chase continues.
    expect(rows(sid).some((x) => x.content === 'B!')).toBe(false);

    // B's reply finally flushes — tail becomes an assistant line.
    writeTranscript(tfile, [uA, aA, uB, aB]);
    await until(() => rows(sid).some((x) => x.content === 'B!'));
    expect(rows(sid).map((x) => x.content)).toEqual(['A?', 'A!', 'B?', 'B!']);

    stopCapture(sid);
  });

  it('catch-up fold on re-attach recovers a reply orphaned by a restart (no next Stop)', async () => {
    // Root cause of "the last turn never shows in history": the rescan tail that
    // chases a late-flushing reply is an in-memory timer. A backend restart inside
    // that window kills it, leaving the reply orphaned (cursor frozen on the user
    // line). The old code waited for a FUTURE Stop to re-scan past it — which never
    // came if the next turn was interrupted or the backend kept restarting. On
    // re-attach, startCapture must fold the transcript from the cursor itself.
    const sid = 'sess-cap-orphan';
    insertSession(sid);
    const resumeId = 'claude-orphan';
    // The real path startCapture's catch-up derives from (cwd + resume id).
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));

    const userLine = {
      type: 'user',
      uuid: 'ou1',
      parentUuid: null,
      message: { role: 'user', content: 'why is the sky blue?' },
    };
    const reply = {
      type: 'assistant',
      uuid: 'oa1',
      parentUuid: 'ou1',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Rayleigh scattering.' }],
      },
    };
    // Both lines are in the transcript; the reply HAS flushed.
    writeTranscript(tpath, [userLine, reply]);

    // Reconstruct the exact orphaned end-state a restart-during-rescan leaves
    // behind, WITHOUT starting a rescan timer (an in-process timer would survive
    // stopCapture and mask the bug): the user line was captured and the cursor
    // advanced to it, but the reply is still uncaptured.
    persistMessage({ sessionId: sid, planItemId: null, role: 'user', content: 'why is the sky blue?', transcriptUuid: 'ou1' });
    getDb()
      .prepare('UPDATE sessions SET last_captured_transcript_uuid=?, agent_session_id=? WHERE id=?')
      .run('ou1', resumeId, sid);
    expect(rows(sid).some((x) => x.role === 'assistant')).toBe(false);

    // Re-attach with the resume token (as spawnAgentTerminal does). The catch-up
    // fold must recover the orphaned reply WITHOUT any further Stop.
    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((x) => x.role === 'assistant'));
    const r = rows(sid);
    expect(r.map((x) => x.content)).toEqual(['why is the sky blue?', 'Rayleigh scattering.']);
    expect(r.find((x) => x.role === 'assistant')?.transcript_uuid).toBe('oa1');

    // Cursor advanced past the reply so a later Stop won't re-capture it.
    const cur = getDb()
      .prepare('SELECT last_captured_transcript_uuid AS c FROM sessions WHERE id=?')
      .get(sid) as { c: string | null };
    expect(cur.c).toBe('oa1');

    stopCapture(sid);
  });

  it('migrates a legacy UUID cursor to a durable byte boundary and captures only later lines', async () => {
    const sid = 'sess-cap-legacy';
    const resumeId = 'claude-legacy';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    const first = userLine('legacy-u1', 'already captured');
    const reply = assistantLine('legacy-a1', 'new reply', 'legacy-u1');
    writeTranscript(tpath, [first, reply]);
    persistMessage({
      sessionId: sid,
      planItemId: null,
      role: 'user',
      content: 'already captured',
      transcriptUuid: 'legacy-u1',
    });
    getDb()
      .prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?')
      .run('legacy-u1', sid);

    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'new reply'));

    expect(rows(sid).map((row) => row.content)).toEqual(['already captured', 'new reply']);
    expect(captureState(sid)).toMatchObject({
      completeOffset: Buffer.byteLength(`${JSON.stringify(first)}\n${JSON.stringify(reply)}\n`),
      lastTranscriptUuid: 'legacy-a1',
      lastConversationType: 'assistant',
    });
    stopCapture(sid);
  });

  it('replays from zero when a missing legacy UUID is fully deduplicable', async () => {
    const sid = 'sess-cap-missing-safe';
    const resumeId = 'claude-missing-safe';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    writeTranscript(tpath, [
      userLine('safe-u1', 'deduplicated user'),
      assistantLine('safe-a1', 'captured assistant', 'safe-u1'),
    ]);
    persistMessage({
      sessionId: sid,
      planItemId: null,
      role: 'user',
      content: 'deduplicated user',
      transcriptUuid: 'safe-u1',
    });
    getDb()
      .prepare('UPDATE sessions SET last_captured_transcript_uuid = ? WHERE id = ?')
      .run('missing-uuid', sid);

    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'captured assistant'));

    expect(rows(sid).map((row) => row.content)).toEqual([
      'deduplicated user',
      'captured assistant',
    ]);
    expect(captureState(sid)?.lastTranscriptUuid).toBe('safe-a1');
    stopCapture(sid);
  });

  it('seeds at complete EOF when existing source history has no transcript UUID', async () => {
    const sid = 'sess-cap-missing-ambiguous';
    const resumeId = 'claude-missing-ambiguous';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    const oldLines = [
      userLine('amb-u1', 'old native user'),
      assistantLine('amb-a1', 'old native assistant', 'amb-u1'),
    ];
    writeTranscript(tpath, oldLines);
    persistMessage({
      sessionId: sid,
      planItemId: null,
      role: 'assistant',
      content: 'existing SDK history',
    });

    await startCapture(sid, resumeId);
    expect(rows(sid).map((row) => row.content)).toEqual(['existing SDK history']);
    expect(captureState(sid)).toMatchObject({
      completeOffset: Buffer.byteLength(oldLines.map((line) => JSON.stringify(line)).join('\n')) + 1,
      lastTranscriptUuid: 'amb-a1',
      lastConversationType: 'assistant',
    });

    appendTranscript(tpath, [
      userLine('amb-u2', 'new user', 'amb-a1'),
      assistantLine('amb-a2', 'new assistant', 'amb-u2'),
    ]);
    await fireStop(sid, tpath, resumeId);
    expect(rows(sid).map((row) => row.content)).toEqual([
      'existing SDK history',
      'new user',
      'new assistant',
    ]);
    stopCapture(sid);
  });

  it('advances the durable offset for complete malformed and noise records', async () => {
    const sid = 'sess-cap-noise';
    insertSession(sid);
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-noise-'));
    const tfile = path.join(dir, 'claude-noise.jsonl');
    writeTranscript(tfile, [
      userLine('noise-u1', 'hello'),
      assistantLine('noise-a1', 'world', 'noise-u1'),
    ]);
    await startCapture(sid, null);
    await fireStop(sid, tfile, 'claude-noise');
    const priorOffset = captureState(sid)?.completeOffset ?? 0;

    appendFileSync(tfile, 'not-json\n', 'utf8');
    appendTranscript(tfile, [{ type: 'progress', uuid: 'noise-progress' }]);
    await fireStop(sid, tfile, 'claude-noise');

    expect(rows(sid)).toHaveLength(2);
    expect(captureState(sid)).toMatchObject({
      completeOffset: priorOffset + Buffer.byteLength('not-json\n') +
        Buffer.byteLength(`${JSON.stringify({ type: 'progress', uuid: 'noise-progress' })}\n`),
      lastTranscriptUuid: 'noise-a1',
      lastConversationType: 'assistant',
    });
    stopCapture(sid);
  });

  it('rolls back messages, cursor, and broadcasts together when state persistence fails', async () => {
    const sid = 'sess-cap-atomic';
    const resumeId = 'claude-atomic';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    writeTranscript(tpath, [
      userLine('atomic-u1', 'first user'),
      assistantLine('atomic-a1', 'first assistant', 'atomic-u1'),
    ]);
    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'first assistant'));
    const committed = captureState(sid);
    appendTranscript(tpath, [
      userLine('atomic-u2', 'second user', 'atomic-a1'),
      assistantLine('atomic-a2', 'second assistant', 'atomic-u2'),
    ]);

    const db = getDb();
    db.exec(
      `CREATE TEMP TRIGGER fail_claude_state_update
       BEFORE UPDATE ON claude_transcript_state
       WHEN NEW.complete_offset > OLD.complete_offset
       BEGIN
         SELECT RAISE(FAIL, 'forced state failure');
       END;`,
    );
    const { events, socket } = captureEvents();
    hub.subscribe(`session:${sid}`, socket);
    try {
      await fireStop(sid, tpath, resumeId);
      stopCapture(sid);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(rows(sid).map((row) => row.content)).toEqual(['first user', 'first assistant']);
      expect(captureState(sid)).toEqual(committed);
      expect(events.filter((event) => event.type === 'message')).toHaveLength(0);

      db.exec('DROP TRIGGER fail_claude_state_update');
      await startCapture(sid, resumeId);
      await until(() => rows(sid).some((row) => row.content === 'second assistant'));
      expect(rows(sid).map((row) => row.content)).toEqual([
        'first user',
        'first assistant',
        'second user',
        'second assistant',
      ]);
      expect(events.filter((event) => event.type === 'message')).toHaveLength(2);
    } finally {
      hub.unsubscribe(`session:${sid}`, socket);
      db.exec('DROP TRIGGER IF EXISTS fail_claude_state_update');
      stopCapture(sid);
    }
  });

  it('persists a zero cursor before accepting a replacement transcript generation', async () => {
    const sid = 'sess-cap-replace';
    const resumeId = 'claude-replace';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    writeTranscript(tpath, [
      userLine('replace-u1', 'old user'),
      assistantLine('replace-a1', 'old assistant', 'replace-u1'),
    ]);
    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'old assistant'));
    const oldIdentity = captureState(sid)?.transcriptIdentity;

    const replacement = `${tpath}.replacement`;
    writeTranscript(replacement, [
      userLine('replace-u2', 'new user'),
      assistantLine('replace-a2', 'new assistant', 'replace-u2'),
    ]);
    renameSync(replacement, tpath);
    const db = getDb();
    db.exec(
      `CREATE TEMP TRIGGER fail_claude_replacement_commit
       BEFORE UPDATE ON claude_transcript_state
       WHEN OLD.complete_offset = 0 AND NEW.complete_offset > 0
       BEGIN
         SELECT RAISE(FAIL, 'forced replacement failure');
       END;`,
    );

    await fireStop(sid, tpath, resumeId);
    stopCapture(sid);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(rows(sid).map((row) => row.content)).toEqual(['old user', 'old assistant']);
    expect(captureState(sid)).toMatchObject({
      completeOffset: 0,
      lastTranscriptUuid: null,
      lastConversationType: null,
    });
    expect(captureState(sid)?.transcriptIdentity).not.toBe(oldIdentity);

    db.exec('DROP TRIGGER fail_claude_replacement_commit');
    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'new assistant'));
    expect(rows(sid).map((row) => row.content)).toEqual([
      'old user',
      'old assistant',
      'new user',
      'new assistant',
    ]);
    stopCapture(sid);
  });

  it('restores the durable tail when persisting a replacement zero cursor fails', async () => {
    const sid = 'sess-cap-reset-failure';
    const resumeId = 'claude-reset-failure';
    insertSession(sid);
    const tpath = sessionFilePath(cwdOf(sid), resumeId);
    mkdirSync(path.dirname(tpath), { recursive: true });
    transcriptDirsToClean.push(path.dirname(tpath));
    writeTranscript(tpath, [
      userLine('reset-old-u', 'old user'),
      assistantLine('reset-old-a', 'old assistant', 'reset-old-u'),
    ]);
    await startCapture(sid, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'old assistant'));
    const oldState = captureState(sid);

    const replacement = `${tpath}.replacement`;
    writeTranscript(replacement, [
      userLine('reset-new-u', 'new user'),
      assistantLine('reset-new-a', 'new assistant', 'reset-new-u'),
    ]);
    renameSync(replacement, tpath);
    const db = getDb();
    db.exec(
      `CREATE TEMP TRIGGER fail_claude_zero_cursor
       BEFORE UPDATE ON claude_transcript_state
       WHEN NEW.complete_offset = 0
       BEGIN
         SELECT RAISE(FAIL, 'forced zero cursor failure');
       END;`,
    );

    await fireStop(sid, tpath, resumeId);
    expect(captureState(sid)).toEqual(oldState);
    expect(rows(sid).map((row) => row.content)).toEqual(['old user', 'old assistant']);

    db.exec('DROP TRIGGER fail_claude_zero_cursor');
    await fireStop(sid, tpath, resumeId);
    await until(() => rows(sid).some((row) => row.content === 'new assistant'));
    expect(rows(sid).map((row) => row.content)).toEqual([
      'old user',
      'old assistant',
      'new user',
      'new assistant',
    ]);
    stopCapture(sid);
  });
});
