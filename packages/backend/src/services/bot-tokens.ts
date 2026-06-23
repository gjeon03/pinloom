// Per-bot-session ephemeral tokens used by the pinloom MCP server (bot mode) to
// prove it was spawned by the current run of a known bot session. Same coherence
// guard as team-tokens.ts (stale shims from a previous backend incarnation fail
// loudly), keyed by bot sessionId instead of teamId. In-process only — dies with
// the backend. Single-user local app: this is NOT a security boundary.

import { timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';

const sessionToToken = new Map<string, string>();
const tokenToSession = new Map<string, string>();

/** Mint a fresh token for a bot session, replacing any prior one. */
export function mintBotToken(sessionId: string): string {
  const prior = sessionToToken.get(sessionId);
  if (prior) tokenToSession.delete(prior);
  const token = nanoid(32);
  sessionToToken.set(sessionId, token);
  tokenToSession.set(token, sessionId);
  return token;
}

export function clearBotToken(sessionId: string): void {
  const prior = sessionToToken.get(sessionId);
  if (prior) tokenToSession.delete(prior);
  sessionToToken.delete(sessionId);
}

/** Returns the bot sessionId whose token matches `presented`, or null. */
export function resolveBotSessionByToken(presented: string): string | null {
  const candidate = tokenToSession.get(presented);
  if (!candidate) return null;
  const stored = sessionToToken.get(candidate);
  if (!stored) return null;
  if (presented.length !== stored.length) return null;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(stored))
    ? candidate
    : null;
}
