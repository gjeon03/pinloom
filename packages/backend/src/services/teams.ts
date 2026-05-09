// Teams group an orchestrator session with N worker sessions. The
// orchestrator agent addresses workers by `alias` (e.g. "@backend") via
// the pinloom MCP server (PR2); this module owns the persistent
// membership state and exposes simple CRUD with typed errors so the
// HTTP/UX layer can map them to user-friendly messages.
//
// Membership invariants:
//   - every team has exactly one orchestrator session (NOT NULL)
//   - the orchestrator is not also a worker of any team
//   - workers are bound to ≤ 1 team
//   - an alias is unique within its team (cross-team duplicates are fine)
//
// We pre-check most of these in the service layer (single-user local app
// — TOCTOU is not a concern) so users get a clean typed error rather than
// a raw SqliteError. The schema's UNIQUE indexes act as a defensive net.

import { nanoid } from 'nanoid';
import type { Team, TeamMember } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { clearTeamToken } from './team-tokens.js';
import { clearTeamEvents } from './team-events.js';

const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export class TeamNotFoundError extends Error {
  constructor(id: string) {
    super(`team not found: ${id}`);
    this.name = 'TeamNotFoundError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionAlreadyInTeamError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} already belongs to a team`);
    this.name = 'SessionAlreadyInTeamError';
  }
}

export class OrchestratorWorkerConflictError extends Error {
  constructor(sessionId: string) {
    super(
      `session ${sessionId} is the orchestrator of this team — cannot also be a worker`,
    );
    this.name = 'OrchestratorWorkerConflictError';
  }
}

export class InvalidAliasError extends Error {
  constructor(alias: string) {
    super(
      `invalid alias ${JSON.stringify(alias)}: must match /^[a-z][a-z0-9_-]{0,31}$/`,
    );
    this.name = 'InvalidAliasError';
  }
}

export class AliasTakenError extends Error {
  constructor(alias: string) {
    super(`alias "${alias}" is already used by another worker in this team`);
    this.name = 'AliasTakenError';
  }
}

interface TeamRow {
  id: string;
  name: string;
  orchestrator_session_id: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  team_id: string;
  session_id: string;
  alias: string;
  created_at: string;
}

function rowToMember(row: MemberRow): TeamMember {
  return {
    sessionId: row.session_id,
    alias: row.alias,
    createdAt: row.created_at,
  };
}

function loadMembers(teamId: string): TeamMember[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM team_members
       WHERE team_id = ?
       ORDER BY created_at ASC, alias ASC`,
    )
    .all(teamId) as MemberRow[];
  return rows.map(rowToMember);
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    orchestratorSessionId: row.orchestrator_session_id,
    members: loadMembers(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTeams(): Team[] {
  const rows = getDb()
    .prepare('SELECT * FROM teams ORDER BY created_at DESC')
    .all() as TeamRow[];
  return rows.map(rowToTeam);
}

export function getTeam(id: string): Team | null {
  const row = getDb()
    .prepare('SELECT * FROM teams WHERE id = ?')
    .get(id) as TeamRow | undefined;
  return row ? rowToTeam(row) : null;
}

interface CreateTeamArgs {
  name: string;
  orchestratorSessionId: string;
}

export function createTeam(args: CreateTeamArgs): Team {
  const id = nanoid();
  const now = new Date().toISOString();
  const db = getDb();

  // Wrap pre-checks + INSERT in a single SQLite transaction so a concurrent
  // session delete or competing team creation cannot wedge us into a half-
  // applied state.
  const tx = db.transaction(() => {
    assertSessionExists(args.orchestratorSessionId);
    assertSessionFree(args.orchestratorSessionId);
    db.prepare(
      `INSERT INTO teams (id, name, orchestrator_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, args.name, args.orchestratorSessionId, now, now);
  });
  tx();

  return getTeam(id) as Team;
}

interface UpdateTeamArgs {
  name?: string;
  orchestratorSessionId?: string;
}

export function updateTeam(id: string, args: UpdateTeamArgs): Team {
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = getTeam(id);
    if (!existing) throw new TeamNotFoundError(id);

    const nextName = args.name ?? existing.name;
    const nextOrchestrator =
      args.orchestratorSessionId ?? existing.orchestratorSessionId;

    if (nextOrchestrator !== existing.orchestratorSessionId) {
      assertSessionExists(nextOrchestrator);
      assertSessionFree(nextOrchestrator);
    }

    db.prepare(
      `UPDATE teams
       SET name = ?, orchestrator_session_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextName, nextOrchestrator, new Date().toISOString(), id);
  });
  tx();

  return getTeam(id) as Team;
}

export function deleteTeam(id: string): boolean {
  const result = getDb().prepare('DELETE FROM teams WHERE id = ?').run(id);
  if (result.changes > 0) {
    clearTeamToken(id);
    clearTeamEvents(id);
  }
  return result.changes > 0;
}

interface AddMemberArgs {
  teamId: string;
  sessionId: string;
  alias: string;
}

export function addMember(args: AddMemberArgs): TeamMember {
  if (!ALIAS_PATTERN.test(args.alias)) throw new InvalidAliasError(args.alias);

  const now = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    const team = getTeam(args.teamId);
    if (!team) throw new TeamNotFoundError(args.teamId);
    if (args.sessionId === team.orchestratorSessionId) {
      throw new OrchestratorWorkerConflictError(args.sessionId);
    }
    assertSessionExists(args.sessionId);
    assertSessionFree(args.sessionId);
    assertAliasFree(args.teamId, args.alias);

    db.prepare(
      `INSERT INTO team_members (team_id, session_id, alias, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(args.teamId, args.sessionId, args.alias, now);
    touchTeam(args.teamId);
  });
  tx();

  return { sessionId: args.sessionId, alias: args.alias, createdAt: now };
}

interface UpdateMemberArgs {
  teamId: string;
  sessionId: string;
  alias: string;
}

export function updateMemberAlias(args: UpdateMemberArgs): TeamMember {
  if (!ALIAS_PATTERN.test(args.alias)) throw new InvalidAliasError(args.alias);

  const db = getDb();
  let createdAt = '';
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT * FROM team_members WHERE team_id = ? AND session_id = ?',
      )
      .get(args.teamId, args.sessionId) as MemberRow | undefined;
    if (!existing) {
      throw new TeamNotFoundError(`${args.teamId}/${args.sessionId}`);
    }
    createdAt = existing.created_at;

    if (args.alias !== existing.alias) {
      assertAliasFree(args.teamId, args.alias);
    }

    db.prepare(
      'UPDATE team_members SET alias = ? WHERE team_id = ? AND session_id = ?',
    ).run(args.alias, args.teamId, args.sessionId);
    touchTeam(args.teamId);
  });
  tx();

  return { sessionId: args.sessionId, alias: args.alias, createdAt };
}

export function removeMember(teamId: string, sessionId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM team_members WHERE team_id = ? AND session_id = ?')
    .run(teamId, sessionId);
  if (result.changes > 0) touchTeam(teamId);
  return result.changes > 0;
}

// Session ids currently bound to any team — orchestrator OR worker.
// Used by the UI / MCP layer to filter pickers; the architect noted
// returning a Set keeps this simple while letting callers join with
// rich session metadata they already have on hand.
// PR2 helpers: the MCP server resolves the calling orchestrator session
// to its team, then resolves a worker alias to a session id. Co-locating
// the SQL here keeps the schema knowledge in one module.
export function getTeamByOrchestratorSessionId(sessionId: string): Team | null {
  const row = getDb()
    .prepare('SELECT * FROM teams WHERE orchestrator_session_id = ?')
    .get(sessionId) as TeamRow | undefined;
  return row ? rowToTeam(row) : null;
}

export function getMemberByAlias(
  teamId: string,
  alias: string,
): TeamMember | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM team_members WHERE team_id = ? AND alias = ?',
    )
    .get(teamId, alias) as MemberRow | undefined;
  return row ? rowToMember(row) : null;
}

export function listBoundSessionIds(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS id FROM team_members
       UNION
       SELECT orchestrator_session_id AS id FROM teams`,
    )
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function touchTeam(teamId: string) {
  getDb()
    .prepare('UPDATE teams SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), teamId);
}

function assertSessionExists(sessionId: string): void {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM sessions WHERE id = ?')
    .get(sessionId);
  if (!row) throw new SessionNotFoundError(sessionId);
}

function assertSessionFree(sessionId: string): void {
  const asOrch = getDb()
    .prepare('SELECT id FROM teams WHERE orchestrator_session_id = ?')
    .get(sessionId);
  if (asOrch) throw new SessionAlreadyInTeamError(sessionId);
  const asWorker = getDb()
    .prepare('SELECT team_id FROM team_members WHERE session_id = ?')
    .get(sessionId);
  if (asWorker) throw new SessionAlreadyInTeamError(sessionId);
}

function assertAliasFree(teamId: string, alias: string): void {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM team_members WHERE team_id = ? AND alias = ?')
    .get(teamId, alias);
  if (row) throw new AliasTakenError(alias);
}
