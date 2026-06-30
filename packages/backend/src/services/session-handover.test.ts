import { beforeEach, describe, it, expect } from 'vitest';
import { getDb } from '../db/connection.js';
import { generateSessionHandover } from './session-handover.js';

const db = getDb();

function reset() {
  db.exec(
    'DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects; DELETE FROM session_timeline_days; DELETE FROM session_timelines;',
  );
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

  it('caches per-day notes — regen with no new messages re-distills 0 days', async () => {
    addMsg('m1', 'user', 'do the migration', '2026-06-10T09:00:00Z');
    addMsg('m2', 'assistant', 'considered A vs B', '2026-06-10T09:05:00Z');
    let calls = 0;
    const counting = async (sys: string, p: string) => {
      calls += 1;
      return stub(sys, p);
    };
    await generateSessionHandover('s1', { runText: counting });
    const first = calls; // 1 day distill + 1 summary
    expect(first).toBeGreaterThan(1);
    calls = 0;
    await generateSessionHandover('s1', { runText: counting }); // unchanged
    // day note served from cache → only the (uncached) summary call runs
    expect(calls).toBe(1);
  });

  it('re-distills only a day whose content changed', async () => {
    addMsg('m1', 'user', 'day one', '2026-06-10T09:00:00Z');
    addMsg('m2', 'user', 'day two', '2026-06-12T09:00:00Z');
    let calls = 0;
    const counting = async (sys: string, p: string) => {
      calls += 1;
      return stub(sys, p);
    };
    await generateSessionHandover('s1', { runText: counting }); // 2 days + summary
    calls = 0;
    addMsg('m3', 'assistant', 'more on day two', '2026-06-12T10:00:00Z'); // changes day2 only
    await generateSessionHandover('s1', { runText: counting });
    // day1 cached (reused), day2 changed (1 distill) + summary = 2 calls
    expect(calls).toBe(2);
  });

  it('range filter (since) limits which days are included', async () => {
    addMsg('a', 'user', 'd1', '2026-06-10T09:00:00Z');
    addMsg('b', 'user', 'd2', '2026-06-12T09:00:00Z');
    addMsg('c', 'user', 'd3', '2026-06-14T09:00:00Z');
    const r = await generateSessionHandover('s1', { runText: stub, since: '2026-06-12' });
    expect(r.days).toBe(2);
    expect(r.markdown).not.toContain('## 2026-06-10');
    expect(r.markdown).toContain('## 2026-06-12');
    expect(r.markdown).toContain('## 2026-06-14');
  });

  it('range with no matching days returns a friendly note (no throw)', async () => {
    addMsg('a', 'user', 'd1', '2026-06-10T09:00:00Z');
    const r = await generateSessionHandover('s1', { runText: stub, since: '2026-07-01' });
    expect(r.days).toBe(0);
    expect(r.markdown).toContain('no conversation in range');
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
