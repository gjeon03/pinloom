// Per-orchestrator-session ephemeral tokens used by the MCP server to
// prove it was spawned by the current run of a known team. Lives only
// in process memory — dies with the backend, which is fine: a stale
// shim from a previous backend incarnation should not be able to
// dispatch into a live run.
//
// The MCP server reads PINLOOM_TEAM_TOKEN from its env (injected by the
// runner at agent spawn time) and presents it as the `X-Pinloom-Team-
// Token` header on every request to /api/teams/:teamId/dispatch/*.
//
// Single-user local app — this is *not* a security boundary against
// other users on the same machine. It is a coherence guard: stale or
// orphaned shims fail loudly instead of silently dispatching into the
// wrong run.

import { nanoid } from 'nanoid';

const tokensByTeamId = new Map<string, string>();

/**
 * Mints a new token for the given team, replacing any prior token (so
 * a fresh orchestrator run automatically invalidates stale shims).
 */
export function mintTeamToken(teamId: string): string {
  const token = nanoid(32);
  tokensByTeamId.set(teamId, token);
  return token;
}

export function clearTeamToken(teamId: string): void {
  tokensByTeamId.delete(teamId);
}

/**
 * Returns the team id whose token matches `presented`, or null if none.
 * The MCP server presents a token without claiming a team id; the
 * backend resolves the team from the token to make it harder for a
 * confused shim to scribble across teams.
 */
export function resolveTeamByToken(presented: string): string | null {
  for (const [teamId, token] of tokensByTeamId.entries()) {
    if (token === presented) return teamId;
  }
  return null;
}
