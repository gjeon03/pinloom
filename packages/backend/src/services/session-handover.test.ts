import { beforeEach, describe, it, expect } from 'vitest';
import { getDb } from '../db/connection.js';
import { generateSessionHandover } from './session-handover.js';

const db = getDb();

function reset() {
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
  db.prepare(
    'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'proj', '/tmp/x', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
  db.prepare(
    'INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run('s1', 'p1', 'billing work', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
}
function addMsg(id: string, role: string, content: string, createdAt: string) {
  db.prepare(
    'INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)',
  ).run(id, 's1', role, content, createdAt);
}

// Stub the LLM so the test is offline + deterministic; tags output by which
// system prompt was used so we can assert the two distinct passes ran.
const stub = async (system: string, _prompt: string) =>
  system.includes('HANDOVER SUMMARY')
    ? '## Current state\nstub-summary'
    : '### did stuff\nstub-day';

describe('generateSessionHandover', () => {
  beforeEach(reset);

  it('produces summary + one day-by-day section per local day', async () => {
    addMsg('m1', 'user', 'do the billing migration', '2026-06-10T09:00:00Z');
    addMsg('m2', 'assistant', 'considered A vs B, chose B because…', '2026-06-10T09:05:00Z');
    addMsg('m3', 'user', 'continue next day', '2026-06-12T09:00:00Z');
    const r = await generateSessionHandover('s1', { runText: stub });
    expect(r.days).toBe(2);
    expect(r.truncatedDays).toBe(0);
    expect(r.markdown).toContain('# Handover — billing work');
    expect(r.markdown).toContain('# Day-by-day');
    expect(r.markdown).toContain('## 2026-06-10');
    expect(r.markdown).toContain('## 2026-06-12');
    expect(r.markdown).toContain('stub-summary');
    expect(r.markdown).toContain('stub-day');
  });

  it('handles an empty session gracefully', async () => {
    const r = await generateSessionHandover('s1', { runText: stub });
    expect(r.days).toBe(0);
    expect(r.markdown).toContain('no conversation to hand over');
  });

  it('throws on a missing session', async () => {
    await expect(generateSessionHandover('nope', { runText: stub })).rejects.toThrow(
      /not found/,
    );
  });
});
