import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/connection.js';
import { recordSkillUse, getSkillUsage } from './skill-usage.js';
import { persistMessage } from './runner.js';

const db = getDb();

function reset() {
  db.exec('DELETE FROM skill_usage; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
}

describe('skill usage', () => {
  beforeEach(reset);

  it('records, increments, and reads counts + lastUsedAt', () => {
    recordSkillUse('plan-before-work', '2026-06-30T00:00:00Z');
    recordSkillUse('plan-before-work', '2026-06-30T01:00:00Z');
    recordSkillUse('other');
    const u = getSkillUsage();
    expect(u.get('plan-before-work')?.count).toBe(2);
    expect(u.get('plan-before-work')?.lastUsedAt).toBe('2026-06-30T01:00:00Z');
    expect(u.get('other')?.count).toBe(1);
  });

  it('ignores empty names', () => {
    recordSkillUse('');
    expect(getSkillUsage().size).toBe(0);
  });

  it('persistMessage counts a Skill tool_use once (not on dedupe re-scan)', () => {
    const now = '2026-06-30T00:00:00Z';
    db.prepare('INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)').run(
      'p1', 'p', '/tmp/p', now, now,
    );
    db.prepare('INSERT INTO sessions (id,project_id,created_at,updated_at) VALUES (?,?,?,?)').run(
      's1', 'p1', now, now,
    );
    const args = {
      sessionId: 's1',
      planItemId: null,
      role: 'tool' as const,
      content: 'Skill: my-skill',
      toolUse: { name: 'Skill', input: { skill: 'my-skill' } },
      transcriptUuid: 'uuid-1',
    };
    persistMessage(args);
    persistMessage(args); // dedupe re-scan (same transcript_uuid) — must NOT double-count
    expect(getSkillUsage().get('my-skill')?.count).toBe(1);

    // a non-Skill tool doesn't count
    persistMessage({
      sessionId: 's1',
      planItemId: null,
      role: 'tool',
      content: 'Bash: ls',
      toolUse: { name: 'Bash', input: { command: 'ls' } },
      transcriptUuid: 'uuid-2',
    });
    expect(getSkillUsage().size).toBe(1);
  });
});
