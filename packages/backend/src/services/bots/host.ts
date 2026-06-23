// Hosting for built-in bots: a single hidden "Bots" project holds one session
// per bot_kind (singleton). Hidden so it never shows in the project sidebar or
// session pickers; the bot's real working directory is resolved per-turn by the
// runner (registry.resolveCwd), so this project's cwd is only a placeholder.

import { nanoid } from 'nanoid';
import type { BotKind } from '@pinloom/shared';
import { getDb } from '../../db/connection.js';
import { claudeTransport } from '../agents/index.js';
import { getBotsRoot } from './paths.js';
import { getBotDefinition } from './registry.js';

const BOTS_PROJECT_NAME = 'Bots';

/** Find-or-create the hidden project that hosts bot sessions. Returns its id. */
export function ensureBotsProject(): string {
  const db = getDb();
  const cwd = getBotsRoot();
  const existing = db
    .prepare('SELECT id FROM projects WHERE hidden = 1 AND cwd = ?')
    .get(cwd) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, cwd, group_id, order_index, hidden, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, 1, ?, ?)`,
  ).run(id, BOTS_PROJECT_NAME, cwd, now, now);
  return id;
}

/**
 * Find-or-create the singleton session for a bot kind. Returns the session id.
 * Throws if the kind has no registered definition (caller should 400).
 */
export function ensureBotSession(kind: BotKind): string {
  const def = getBotDefinition(kind);
  if (!def) throw new Error(`unknown bot kind: ${kind}`);
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM sessions WHERE bot_kind = ? ORDER BY created_at ASC LIMIT 1')
    .get(kind) as { id: string } | undefined;
  if (existing) return existing.id;

  const projectId = ensureBotsProject();
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions
       (id, project_id, plan_id, agent, claude_session_id, agent_session_id,
        title, order_index, transport, bot_kind, created_at, updated_at)
     VALUES (?, ?, NULL, 'claude', NULL, NULL, ?, 0, ?, ?, ?, ?)`,
  ).run(id, projectId, def.title, claudeTransport(), kind, now, now);
  return id;
}
