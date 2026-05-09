// User-managed environment variables. These are stored in pinloom's SQLite
// (`user_env` table) and merged into the backend's `process.env` so every
// agent run inherits them — Claude SDK's Bash tool and Codex's spawned
// commands both read from the parent's env, no per-adapter wiring needed.
//
// `is_secret` only controls UI masking; it is *not* a security boundary.
// Anyone with shell access to the host can read process.env.

import type { UserEnvVar, UserEnvVarWithValue } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { reloadSecretValues } from './redact.js';

interface UserEnvRow {
  key: string;
  value: string;
  description: string | null;
  is_secret: number;
  created_at: string;
  updated_at: string;
}

// Env var keys must be POSIX-style identifiers. We don't reserve any keys —
// users can override PATH/HOME/etc. if they really want to, and pinloom's
// own internals use the PINLOOM_ prefix which the user is unlikely to fight.
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function rowToUserEnv(row: UserEnvRow): UserEnvVar {
  return {
    key: row.key,
    description: row.description,
    isSecret: row.is_secret === 1,
    hasValue: row.value.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUserEnvWithValue(row: UserEnvRow): UserEnvVarWithValue {
  return { ...rowToUserEnv(row), value: row.value };
}

export function listUserEnvVars(): UserEnvVar[] {
  return (
    getDb()
      .prepare('SELECT * FROM user_env ORDER BY key ASC')
      .all() as UserEnvRow[]
  ).map(rowToUserEnv);
}

export function getUserEnvVar(key: string): UserEnvVarWithValue | null {
  const row = getDb()
    .prepare('SELECT * FROM user_env WHERE key = ?')
    .get(key) as UserEnvRow | undefined;
  return row ? rowToUserEnvWithValue(row) : null;
}

interface UpsertArgs {
  key: string;
  value: string;
  description?: string | null;
  isSecret?: boolean;
}

export function upsertUserEnvVar(args: UpsertArgs): UserEnvVar {
  if (!isValidKey(args.key)) {
    throw new Error(
      `invalid key: ${JSON.stringify(args.key)} — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  if (args.value.length === 0) {
    throw new Error('value must be non-empty');
  }

  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT created_at FROM user_env WHERE key = ?')
    .get(args.key) as { created_at: string } | undefined;
  const createdAt = existing?.created_at ?? now;
  const isSecret = args.isSecret === false ? 0 : 1;

  db.prepare(
    `INSERT INTO user_env (key, value, description, is_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value       = excluded.value,
       description = excluded.description,
       is_secret   = excluded.is_secret,
       updated_at  = excluded.updated_at`,
  ).run(args.key, args.value, args.description ?? null, isSecret, createdAt, now);

  // Keep the live process env in sync so the change takes effect on the
  // next agent spawn without a backend restart.
  process.env[args.key] = args.value;
  // Refresh the redaction list so the new (or updated) secret value is
  // masked in any tool output that gets broadcast from this point on.
  reloadSecretValues();

  const row = db
    .prepare('SELECT * FROM user_env WHERE key = ?')
    .get(args.key) as UserEnvRow;
  return rowToUserEnv(row);
}

export function deleteUserEnvVar(key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM user_env WHERE key = ?').run(key);
  if (result.changes > 0) {
    delete process.env[key];
    reloadSecretValues();
    return true;
  }
  return false;
}

// Called once on backend startup to mirror every stored var into process.env
// so the very first agent spawn sees the same view subsequent ones do. We
// intentionally overwrite anything inherited from the shell — pinloom's
// stored value is the source of truth.
export function loadUserEnvIntoProcess(): void {
  const rows = getDb()
    .prepare('SELECT key, value FROM user_env')
    .all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    process.env[row.key] = row.value;
  }
  reloadSecretValues();
}
