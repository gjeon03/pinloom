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
// Tags reuse the alias-style restriction for predictability and to keep
// future "broadcast to @tag:foo" parsing unambiguous; they don't need to
// be unique within a team.
const TAG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_TAGS_PER_MEMBER = 16;
// Plenty for system-prompt instructions without becoming an essay box.
const MAX_INSTRUCTIONS_LENGTH = 4000;

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

export class InvalidTagError extends Error {
  constructor(tag: string) {
    super(
      `invalid tag ${JSON.stringify(tag)}: must match /^[a-z][a-z0-9_-]{0,31}$/`,
    );
    this.name = 'InvalidTagError';
  }
}

export class TooManyTagsError extends Error {
  constructor(count: number) {
    super(
      `too many tags (${count}); the per-member limit is ${MAX_TAGS_PER_MEMBER}`,
    );
    this.name = 'TooManyTagsError';
  }
}

export class InstructionsTooLongError extends Error {
  constructor(length: number) {
    super(
      `instructions too long (${length} chars); the limit is ${MAX_INSTRUCTIONS_LENGTH}`,
    );
    this.name = 'InstructionsTooLongError';
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
  // SQLite returns NULL for nullable columns added via ALTER TABLE
  // when the row predates the migration.
  instructions: string | null;
  tags: string | null;
  created_at: string;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        '[teams] tags column not an array — returning empty:',
        raw.slice(0, 100),
      );
      return [];
    }
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch (err) {
    // Corrupt JSON shouldn't crash the read path. Log so DB corruption
    // is visible in the server console rather than silently masquerading
    // as "no tags"; for a single-user local app that's enough.
    console.warn(
      '[teams] failed to parse tags JSON, returning empty:',
      raw.slice(0, 100),
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

function rowToMember(row: MemberRow): TeamMember {
  return {
    sessionId: row.session_id,
    alias: row.alias,
    instructions: row.instructions ?? null,
    tags: parseTags(row.tags),
    createdAt: row.created_at,
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  // Trim, drop empties, and de-dupe in input order. Validation happens
  // separately so a bad input still produces a clean error message.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    result.push(t);
  }
  return result;
}

function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS_PER_MEMBER) {
    throw new TooManyTagsError(tags.length);
  }
  for (const t of tags) {
    if (!TAG_PATTERN.test(t)) throw new InvalidTagError(t);
  }
}

function validateInstructions(
  instructions: string | null | undefined,
): string | null {
  if (instructions == null) return null;
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new InstructionsTooLongError(trimmed.length);
  }
  return trimmed;
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
  instructions?: string | null;
  tags?: string[];
}

export function addMember(args: AddMemberArgs): TeamMember {
  if (!ALIAS_PATTERN.test(args.alias)) throw new InvalidAliasError(args.alias);
  const instructions = validateInstructions(args.instructions);
  const tags = normalizeTags(args.tags);
  validateTags(tags);

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
      `INSERT INTO team_members (team_id, session_id, alias, instructions, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.teamId,
      args.sessionId,
      args.alias,
      instructions,
      tags.length > 0 ? JSON.stringify(tags) : null,
      now,
    );
    touchTeam(args.teamId);
  });
  tx();

  return {
    sessionId: args.sessionId,
    alias: args.alias,
    instructions,
    tags,
    createdAt: now,
  };
}

interface UpdateMemberArgs {
  teamId: string;
  sessionId: string;
  // All fields optional — partial PATCH semantics. Only the fields the
  // caller provides are touched, so the alias-edit flow and the
  // instructions-edit flow can both go through this single entry point.
  alias?: string;
  instructions?: string | null;
  tags?: string[];
}

export function updateMember(args: UpdateMemberArgs): TeamMember {
  if (args.alias !== undefined && !ALIAS_PATTERN.test(args.alias)) {
    throw new InvalidAliasError(args.alias);
  }
  const instructionsProvided = args.instructions !== undefined;
  const instructionsNext = instructionsProvided
    ? validateInstructions(args.instructions)
    : null;
  const tagsProvided = args.tags !== undefined;
  const tagsNext = tagsProvided ? normalizeTags(args.tags) : [];
  if (tagsProvided) validateTags(tagsNext);

  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT * FROM team_members WHERE team_id = ? AND session_id = ?',
      )
      .get(args.teamId, args.sessionId) as MemberRow | undefined;
    if (!existing) {
      throw new TeamNotFoundError(`${args.teamId}/${args.sessionId}`);
    }

    const nextAlias = args.alias ?? existing.alias;
    if (args.alias !== undefined && args.alias !== existing.alias) {
      assertAliasFree(args.teamId, args.alias);
    }
    const nextInstructions = instructionsProvided
      ? instructionsNext
      : existing.instructions;
    const nextTagsRaw = tagsProvided
      ? tagsNext.length > 0
        ? JSON.stringify(tagsNext)
        : null
      : existing.tags;

    db.prepare(
      `UPDATE team_members
         SET alias = ?, instructions = ?, tags = ?
       WHERE team_id = ? AND session_id = ?`,
    ).run(
      nextAlias,
      nextInstructions,
      nextTagsRaw,
      args.teamId,
      args.sessionId,
    );
    touchTeam(args.teamId);
  });
  tx();

  // Re-read the row instead of synthesizing the response from in-memory
  // state. Cheaper to SELECT once than to keep return types in sync
  // with future column additions, and a re-read is inherently
  // truth-of-record (covers any defaults / triggers / etc).
  const fresh = db
    .prepare('SELECT * FROM team_members WHERE team_id = ? AND session_id = ?')
    .get(args.teamId, args.sessionId) as MemberRow | undefined;
  if (!fresh) {
    // The TX already asserted existence; if the row vanished between
    // commit and re-read we have a much bigger problem than a 500.
    throw new TeamNotFoundError(`${args.teamId}/${args.sessionId}`);
  }
  return rowToMember(fresh);
}

// Backwards-compatible thin wrapper for callers that only update alias.
// Kept so the existing route handler stays terse; new persona/tags code
// goes through `updateMember` directly.
export function updateMemberAlias(args: {
  teamId: string;
  sessionId: string;
  alias: string;
}): TeamMember {
  return updateMember(args);
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

// Returns the membership row for a worker session — used by the runner
// to inject persona/tags into the worker's systemPrompt at run time.
// O(1) via the unique idx_team_members_session index.
export function getMemberBySessionId(sessionId: string): TeamMember | null {
  const row = getDb()
    .prepare('SELECT * FROM team_members WHERE session_id = ?')
    .get(sessionId) as MemberRow | undefined;
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
