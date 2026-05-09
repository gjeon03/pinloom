import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import {
  addMember,
  AliasTakenError,
  createTeam,
  deleteTeam,
  getTeam,
  InvalidAliasError,
  listBoundSessionIds,
  listTeams,
  OrchestratorWorkerConflictError,
  removeMember,
  SessionAlreadyInTeamError,
  SessionNotFoundError,
  TeamNotFoundError,
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
