import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import { convertSessionTransport } from './transport-convert.js';

const tempDirs: string[] = [];
let sequence = 0;

beforeEach(() => {
  getDb().exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
});

afterEach(() => {
  const db = getDb();
  db.exec('DROP TRIGGER IF EXISTS fail_transport_update;');
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertClaudeSession(transport: 'sdk' | 'terminal'): {
  sessionId: string;
  agentSessionId: string;
} {
  const suffix = sequence++;
  const sessionId = `transport-session-${suffix}`;
  const projectId = `transport-project-${suffix}`;
  const agentSessionId = `claude-resume-${suffix}`;
  const now = '2026-08-12T00:00:00.000Z';
  const db = getDb();
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'Transport project', `/tmp/transport-${suffix}`, now, now);
  db.prepare(
    `INSERT INTO sessions (
      id, project_id, agent, transport, agent_session_id, claude_session_id,
      last_captured_transcript_uuid, created_at, updated_at
    ) VALUES (?, ?, 'claude', ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    projectId,
    transport,
    agentSessionId,
    agentSessionId,
    transport === 'terminal' ? 'old-cursor' : null,
    now,
    now,
  );
  return { sessionId, agentSessionId };
}

function createClaudeTranscript(root: string, agentSessionId: string): {
  file: string;
  completeContent: string;
} {
  const dir = path.join(root, 'project-slug');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentSessionId}.jsonl`);
  const completeContent = [
    JSON.stringify({ type: 'system', uuid: 'boot' }),
    JSON.stringify({
      type: 'user',
      uuid: 'user-tail',
      message: { role: 'user', content: 'hello' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-tail',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'done' }],
      },
    }),
  ].join('\n') + '\n';
  writeFileSync(file, completeContent + '{"type":"assistant"');
  return { file, completeContent };
}

function tempClaudeProjectsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pinloom-transport-claude-'));
  tempDirs.push(dir);
  return dir;
}

describe('convertSessionTransport Claude transcript state', () => {
  it('seeds the complete checkpoint atomically when converting SDK to terminal', () => {
    const { sessionId, agentSessionId } = insertClaudeSession('sdk');
    const root = tempClaudeProjectsRoot();
    const { file, completeContent } = createClaudeTranscript(root, agentSessionId);

    expect(
      convertSessionTransport(sessionId, 'terminal', { claudeProjectsRoot: root }),
    ).toEqual({ resumeCarried: true });

    const stat = statSync(file);
    expect(
      getDb().prepare(
        `SELECT transcript_identity, complete_offset, last_transcript_uuid,
                last_conversation_type
         FROM claude_transcript_state
         WHERE session_id = ?`,
      ).get(sessionId),
    ).toEqual({
      transcript_identity: `${stat.dev}:${stat.ino}`,
      complete_offset: Buffer.byteLength(completeContent),
      last_transcript_uuid: 'assistant-tail',
      last_conversation_type: 'assistant',
    });
    expect(
      getDb().prepare(
        `SELECT transport, agent_session_id, claude_session_id,
                last_captured_transcript_uuid
         FROM sessions WHERE id = ?`,
      ).get(sessionId),
    ).toEqual({
      transport: 'terminal',
      agent_session_id: agentSessionId,
      claude_session_id: agentSessionId,
      last_captured_transcript_uuid: 'assistant-tail',
    });
  });

  it('rolls back the checkpoint seed if the transport update fails', () => {
    const { sessionId, agentSessionId } = insertClaudeSession('sdk');
    const root = tempClaudeProjectsRoot();
    createClaudeTranscript(root, agentSessionId);
    const db = getDb();
    db.prepare(
      `INSERT INTO claude_transcript_state (
        session_id, transcript_identity, complete_offset,
        last_transcript_uuid, last_conversation_type, updated_at
      ) VALUES (?, 'old:identity', 7, 'old-uuid', 'user', ?)`,
    ).run(sessionId, '2026-08-12T00:00:00.000Z');
    db.exec(`
      CREATE TRIGGER fail_transport_update
      BEFORE UPDATE ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'transport update failed');
      END;
    `);

    expect(() =>
      convertSessionTransport(sessionId, 'terminal', { claudeProjectsRoot: root }),
    ).toThrow('transport update failed');
    expect(
      db.prepare(
        `SELECT transcript_identity, complete_offset, last_transcript_uuid,
                last_conversation_type
         FROM claude_transcript_state WHERE session_id = ?`,
      ).get(sessionId),
    ).toEqual({
      transcript_identity: 'old:identity',
      complete_offset: 7,
      last_transcript_uuid: 'old-uuid',
      last_conversation_type: 'user',
    });
  });

  it('removes terminal reader state without clearing Claude resume identifiers', () => {
    const { sessionId, agentSessionId } = insertClaudeSession('terminal');
    const db = getDb();
    db.prepare(
      `INSERT INTO claude_transcript_state (
        session_id, transcript_identity, complete_offset,
        last_transcript_uuid, last_conversation_type, updated_at
      ) VALUES (?, '1:2', 42, 'assistant-tail', 'assistant', ?)`,
    ).run(sessionId, '2026-08-12T00:00:00.000Z');

    expect(convertSessionTransport(sessionId, 'sdk')).toEqual({ resumeCarried: true });

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM claude_transcript_state WHERE session_id = ?')
        .get(sessionId),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(
        `SELECT transport, agent_session_id, claude_session_id,
                last_captured_transcript_uuid
         FROM sessions WHERE id = ?`,
      ).get(sessionId),
    ).toEqual({
      transport: 'sdk',
      agent_session_id: agentSessionId,
      claude_session_id: agentSessionId,
      last_captured_transcript_uuid: null,
    });
  });
});
