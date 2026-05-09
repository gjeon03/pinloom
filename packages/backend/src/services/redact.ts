// Redacts the literal values of every `is_secret = 1` user env var from
// any string the runner is about to broadcast over WebSocket. The system
// prompt already tells the agent not to echo secrets, but agents
// occasionally do anyway — e.g. via `printenv`, `cat .env`, or a tool
// that dumps the request that's about to be sent. This is the last line
// of defense before plaintext token bytes hit the chat UI.
//
// Notes:
// - Not a security boundary. The plaintext lives in `process.env` and the
//   `user_env` table; anything with shell access can read it.
// - Backed by a small in-memory list rebuilt on startup and on every
//   upsert/delete. Lookups are O(secrets) per redacted string, which is
//   negligible for the dozen-or-so tokens a real user keeps.

import { getDb } from '../db/connection.js';

const REDACTED = '••••••';

// Anything shorter than this is more likely a config knob than a real
// secret, and matching it would mangle ordinary text in tool output.
const MIN_REDACTABLE_LENGTH = 8;

let secretValues: string[] = [];

export function reloadSecretValues(): void {
  const rows = getDb()
    .prepare('SELECT value FROM user_env WHERE is_secret = 1')
    .all() as Array<{ value: string }>;
  // Sort by length DESC so longer values get redacted before any shorter
  // value that happens to be a prefix of them.
  secretValues = rows
    .map((r) => r.value)
    .filter((v) => v.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string): string {
  if (text.length === 0 || secretValues.length === 0) return text;
  let out = text;
  for (const value of secretValues) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

// Test-only: lets the suite assert state without exporting the array.
export function _peekSecretCount(): number {
  return secretValues.length;
}
