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

import { timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';

// Two parallel maps so resolution is O(1) and we can timing-safe compare
// against each candidate without leaking length differences via early-
// out `===`. teamToToken is the source of truth; tokenToTeam is a
// derived inverse rebuilt on every mint.
const teamToToken = new Map<string, string>();
const tokenToTeam = new Map<string, string>();

/**
 * Mints a new token for the given team, replacing any prior token (so
 * a fresh orchestrator run automatically invalidates stale shims).
 */
export function mintTeamToken(teamId: string): string {
  const prior = teamToToken.get(teamId);
  if (prior) tokenToTeam.delete(prior);
  const token = nanoid(32);
  teamToToken.set(teamId, token);
  tokenToTeam.set(token, teamId);
  return token;
}

export function clearTeamToken(teamId: string): void {
  const prior = teamToToken.get(teamId);
  if (prior) tokenToTeam.delete(prior);
  teamToToken.delete(teamId);
}

/**
 * Returns the team id whose token matches `presented`, or null if none.
 * Uses constant-time comparison to avoid byte-level timing oracles even
 * though this is a single-user local app — it costs nothing and keeps
 * the abstraction defensible if teams ever go remote.
 */
export function resolveTeamByToken(presented: string): string | null {
  // Direct map lookup is O(1) but its hash equality is fast-path early-
  // out — not constant-time. Pull the candidate via the lookup, then
  // do a constant-time byte compare against the stored token.
  const candidateTeamId = tokenToTeam.get(presented);
  if (!candidateTeamId) return null;
  const stored = teamToToken.get(candidateTeamId);
  if (!stored) return null;
  if (presented.length !== stored.length) return null;
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  return timingSafeEqual(a, b) ? candidateTeamId : null;
}
