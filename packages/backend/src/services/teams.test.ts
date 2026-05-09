import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import {
  addMember,
  AliasTakenError,
  createTeam,
  deleteTeam,
  getMemberBySessionId,
  getTeam,
  InvalidAliasError,
  InvalidTagError,
  listBoundSessionIds,
  listTeams,
  OrchestratorWorkerConflictError,
  PersonaTooLongError,
  removeMember,
  SessionAlreadyInTeamError,
  SessionNotFoundError,
  TeamNotFoundError,
  TooManyTagsError,
  updateMember,
  updateMemberAlias,
  updateTeam,
} from './teams.js';

function seedSession(id: string, projectId = 'p1') {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'Test', '/tmp/t', now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, projectId, now, now);
}

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM team_members;
    DELETE FROM teams;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM projects;
  `);
});

describe('createTeam', () => {
  it('creates a team with an orchestrator', () => {
    seedSession('s-orch');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's-orch' });
    expect(t.name).toBe('crew');
    expect(t.orchestratorSessionId).toBe('s-orch');
    expect(t.members).toEqual([]);
  });

  it('rejects an unknown session id as orchestrator', () => {
    expect(() =>
      createTeam({ name: 'crew', orchestratorSessionId: 'ghost' }),
    ).toThrow(SessionNotFoundError);
  });

  it('rejects an orchestrator already used by another team', () => {
    seedSession('s-orch');
    createTeam({ name: 'first', orchestratorSessionId: 's-orch' });
    expect(() =>
      createTeam({ name: 'second', orchestratorSessionId: 's-orch' }),
    ).toThrow(SessionAlreadyInTeamError);
  });

  it('rejects an orchestrator that is already a worker', () => {
    seedSession('s-orch1');
    seedSession('s-orch2');
    seedSession('s-worker');
    const a = createTeam({ name: 'a', orchestratorSessionId: 's-orch1' });
    addMember({ teamId: a.id, sessionId: 's-worker', alias: 'b' });
    expect(() =>
      createTeam({ name: 'c', orchestratorSessionId: 's-worker' }),
    ).toThrow(SessionAlreadyInTeamError);
  });
});

describe('updateTeam', () => {
  it('renames a team', () => {
    seedSession('s1');
    const t = createTeam({ name: 'old', orchestratorSessionId: 's1' });
    const updated = updateTeam(t.id, { name: 'new' });
    expect(updated.name).toBe('new');
  });

  it('changes the orchestrator', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    const updated = updateTeam(t.id, { orchestratorSessionId: 's2' });
    expect(updated.orchestratorSessionId).toBe('s2');
  });

  it('rejects an orchestrator already in another team', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    createTeam({ name: 'a', orchestratorSessionId: 's1' });
    const b = createTeam({ name: 'b', orchestratorSessionId: 's3' });
    expect(() => updateTeam(b.id, { orchestratorSessionId: 's1' })).toThrow(
      SessionAlreadyInTeamError,
    );
  });

  it('rejects an unknown session id', () => {
    seedSession('s1');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    expect(() =>
      updateTeam(t.id, { orchestratorSessionId: 'ghost' }),
    ).toThrow(SessionNotFoundError);
  });

  it('throws on unknown team id', () => {
    expect(() => updateTeam('nope', { name: 'x' })).toThrow(TeamNotFoundError);
  });
});

describe('deleteTeam', () => {
  it('removes the team and cascades members', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'worker' });
    expect(deleteTeam(t.id)).toBe(true);
    expect(getTeam(t.id)).toBeNull();
    expect(listBoundSessionIds().has('s2')).toBe(false);
  });

  it('returns false on unknown id', () => {
    expect(deleteTeam('nope')).toBe(false);
  });
});

describe('addMember', () => {
  it('rejects an alias not matching the pattern', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    expect(() =>
      addMember({ teamId: t.id, sessionId: 's2', alias: 'Has Space' }),
    ).toThrow(InvalidAliasError);
    expect(() =>
      addMember({ teamId: t.id, sessionId: 's2', alias: '1starts-digit' }),
    ).toThrow(InvalidAliasError);
  });

  it('rejects adding the orchestrator as a worker', () => {
    seedSession('s-orch');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's-orch' });
    expect(() =>
      addMember({ teamId: t.id, sessionId: 's-orch', alias: 'self' }),
    ).toThrow(OrchestratorWorkerConflictError);
  });

  it('rejects an unknown worker session id', () => {
    seedSession('s1');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    expect(() =>
      addMember({ teamId: t.id, sessionId: 'ghost', alias: 'w' }),
    ).toThrow(SessionNotFoundError);
  });

  it('rejects a session already in another team', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    const a = createTeam({ name: 'a', orchestratorSessionId: 's1' });
    const b = createTeam({ name: 'b', orchestratorSessionId: 's3' });
    addMember({ teamId: a.id, sessionId: 's2', alias: 'w' });
    expect(() =>
      addMember({ teamId: b.id, sessionId: 's2', alias: 'w' }),
    ).toThrow(SessionAlreadyInTeamError);
  });

  it('rejects a duplicate alias within the same team', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'worker' });
    expect(() =>
      addMember({ teamId: t.id, sessionId: 's3', alias: 'worker' }),
    ).toThrow(AliasTakenError);
  });

  it('allows the same alias across different teams', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    seedSession('s4');
    const a = createTeam({ name: 'a', orchestratorSessionId: 's1' });
    const b = createTeam({ name: 'b', orchestratorSessionId: 's3' });
    addMember({ teamId: a.id, sessionId: 's2', alias: 'worker' });
    expect(() =>
      addMember({ teamId: b.id, sessionId: 's4', alias: 'worker' }),
    ).not.toThrow();
  });

  it('touches the team updated_at', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    getDb()
      .prepare('UPDATE teams SET updated_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', t.id);
    addMember({ teamId: t.id, sessionId: 's2', alias: 'w' });
    const after = getTeam(t.id);
    expect(after?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('updateMemberAlias', () => {
  it('renames a member', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'old' });
    const updated = updateMemberAlias({
      teamId: t.id,
      sessionId: 's2',
      alias: 'new',
    });
    expect(updated.alias).toBe('new');
  });

  it('rejects collision with another member in the same team', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'a' });
    addMember({ teamId: t.id, sessionId: 's3', alias: 'b' });
    expect(() =>
      updateMemberAlias({ teamId: t.id, sessionId: 's3', alias: 'a' }),
    ).toThrow(AliasTakenError);
  });
});

describe('removeMember', () => {
  it('frees the session for re-binding', () => {
    seedSession('s1');
    seedSession('s2');
    seedSession('s3');
    const a = createTeam({ name: 'a', orchestratorSessionId: 's1' });
    const b = createTeam({ name: 'b', orchestratorSessionId: 's3' });
    addMember({ teamId: a.id, sessionId: 's2', alias: 'w' });
    expect(removeMember(a.id, 's2')).toBe(true);
    expect(() =>
      addMember({ teamId: b.id, sessionId: 's2', alias: 'w' }),
    ).not.toThrow();
  });
});

describe('listBoundSessionIds', () => {
  it('includes orchestrators and workers', () => {
    seedSession('s-free');
    seedSession('s-orch');
    seedSession('s-worker');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's-orch' });
    addMember({ teamId: t.id, sessionId: 's-worker', alias: 'w' });
    const bound = listBoundSessionIds();
    expect(bound.has('s-free')).toBe(false);
    expect(bound.has('s-orch')).toBe(true);
    expect(bound.has('s-worker')).toBe(true);
  });
});

describe('listTeams', () => {
  it('returns teams with their members loaded', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'worker' });
    const all = listTeams();
    expect(all).toHaveLength(1);
    expect(all[0].members).toHaveLength(1);
    expect(all[0].members[0].alias).toBe('worker');
  });
});

describe('cascade behavior', () => {
  it('removes team_members when a worker session is deleted', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'worker' });
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run('s2');
    const after = getTeam(t.id);
    expect(after?.members).toEqual([]);
  });

  it('cascades the team away when its orchestrator session is deleted', () => {
    seedSession('s1');
    seedSession('s2');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 's1' });
    addMember({ teamId: t.id, sessionId: 's2', alias: 'worker' });
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run('s1');
    expect(getTeam(t.id)).toBeNull();
    // The worker session itself survives — only its team binding is gone.
    expect(listBoundSessionIds().has('s2')).toBe(false);
  });
});

describe('persona and tags', () => {
  it('addMember stores persona and tags', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'crew', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      persona: 'Backend reviewer',
      tags: ['backend', 'tests'],
    });
    const team = getTeam(t.id);
    expect(team?.members[0].persona).toBe('Backend reviewer');
    expect(team?.members[0].tags).toEqual(['backend', 'tests']);
  });

  it('addMember normalizes/dedupes/trims tags', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      tags: [' backend ', 'backend', '', 'tests'],
    });
    expect(getTeam(t.id)?.members[0].tags).toEqual(['backend', 'tests']);
  });

  it('addMember treats empty/whitespace persona as null', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      persona: '   ',
    });
    expect(getTeam(t.id)?.members[0].persona).toBeNull();
  });

  it('rejects invalid tag tokens', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    expect(() =>
      addMember({
        teamId: t.id,
        sessionId: 'w',
        alias: 'be',
        tags: ['Backend'], // uppercase
      }),
    ).toThrow(InvalidTagError);
  });

  it('rejects too many tags', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    expect(() =>
      addMember({
        teamId: t.id,
        sessionId: 'w',
        alias: 'be',
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }),
    ).toThrow(TooManyTagsError);
  });

  it('rejects persona over the length cap', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    expect(() =>
      addMember({
        teamId: t.id,
        sessionId: 'w',
        alias: 'be',
        persona: 'x'.repeat(5000),
      }),
    ).toThrow(PersonaTooLongError);
  });

  it('updateMember edits persona/tags partially without touching alias', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({ teamId: t.id, sessionId: 'w', alias: 'be' });
    updateMember({
      teamId: t.id,
      sessionId: 'w',
      persona: 'Edited',
      tags: ['x'],
    });
    const m = getTeam(t.id)?.members[0];
    expect(m?.alias).toBe('be');
    expect(m?.persona).toBe('Edited');
    expect(m?.tags).toEqual(['x']);
  });

  it('updateMember can clear persona by passing null', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      persona: 'initial',
    });
    updateMember({ teamId: t.id, sessionId: 'w', persona: null });
    expect(getTeam(t.id)?.members[0].persona).toBeNull();
  });

  it('updateMember leaves persona/tags untouched when omitted', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      persona: 'keep',
      tags: ['t'],
    });
    updateMember({ teamId: t.id, sessionId: 'w', alias: 'fe' });
    const m = getTeam(t.id)?.members[0];
    expect(m?.alias).toBe('fe');
    expect(m?.persona).toBe('keep');
    expect(m?.tags).toEqual(['t']);
  });

  it('updateMemberAlias still works (back-compat wrapper)', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({ teamId: t.id, sessionId: 'w', alias: 'be' });
    updateMemberAlias({ teamId: t.id, sessionId: 'w', alias: 'fe' });
    expect(getTeam(t.id)?.members[0].alias).toBe('fe');
  });

  it('getMemberBySessionId returns persona/tags for a worker', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      persona: 'Reviewer',
      tags: ['backend'],
    });
    const m = getMemberBySessionId('w');
    expect(m?.alias).toBe('be');
    expect(m?.persona).toBe('Reviewer');
    expect(m?.tags).toEqual(['backend']);
  });

  it('getMemberBySessionId returns null for free sessions', () => {
    seedSession('free');
    expect(getMemberBySessionId('free')).toBeNull();
  });

  it('getMemberBySessionId returns null for an orchestrator session id', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({ teamId: t.id, sessionId: 'w', alias: 'be' });
    // The runner relies on this distinction: orchestrator gets
    // buildTeamContext, members get buildWorkerPersonaContext, never both.
    expect(getMemberBySessionId('o')).toBeNull();
  });

  it('reads a row whose persona/tags are NULL (pre-mig-17 / cleared)', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({ teamId: t.id, sessionId: 'w', alias: 'be' });
    // Simulate a row that predates migration 17: both columns NULL.
    getDb()
      .prepare(
        'UPDATE team_members SET persona = NULL, tags = NULL WHERE session_id = ?',
      )
      .run('w');
    const m = getMemberBySessionId('w');
    expect(m?.persona).toBeNull();
    expect(m?.tags).toEqual([]);
  });

  it('parseTags tolerates corrupt JSON (returns empty)', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({ teamId: t.id, sessionId: 'w', alias: 'be' });
    // Hand-edit the row to a non-JSON string. parseTags swallows the
    // error and warns; the read path stays alive.
    getDb()
      .prepare('UPDATE team_members SET tags = ? WHERE session_id = ?')
      .run('not-json', 'w');
    expect(getMemberBySessionId('w')?.tags).toEqual([]);
  });

  it('updateMember can clear tags via empty array (stored as NULL)', () => {
    seedSession('o');
    seedSession('w');
    const t = createTeam({ name: 'c', orchestratorSessionId: 'o' });
    addMember({
      teamId: t.id,
      sessionId: 'w',
      alias: 'be',
      tags: ['backend'],
    });
    updateMember({ teamId: t.id, sessionId: 'w', tags: [] });
    expect(getTeam(t.id)?.members[0].tags).toEqual([]);
    // Storage-level: empty arrays are stored as NULL (avoids '[]' churn)
    const raw = getDb()
      .prepare('SELECT tags FROM team_members WHERE session_id = ?')
      .get('w') as { tags: string | null };
    expect(raw.tags).toBeNull();
  });
});
