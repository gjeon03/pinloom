// Read a pinloom session's stored messages and render them as a plain-text
// transcript a bot can summarize. Used by the schedule bot ("write up what I did
// in session X") and the skill bot ("turn session X into a skill"), exposed to
// them via the pinloom_read_session MCP tool.
//
// Pure read against pinloom's own SQLite (the durable history) — no SDK, no
// ~/.claude dependency. `getDb` is injectable so the unit test runs against a
// throwaway database.

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection.js';

export interface SessionTranscriptResult {
  sessionId: string;
  title: string | null;
  projectName: string | null;
  /** Messages actually included in `text` (after limit + budget trimming). */
  includedMessages: number;
  /** Total user/assistant/tool messages in the session. */
  totalMessages: number;
  /** True when older messages were dropped to fit the budget. */
  truncated: boolean;
  text: string;
}

interface Row {
  role: string;
  content: string;
  created_at: string;
}

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 1000;
// Bound the transcript so a giant session can't blow the bot's context window.
const CHAR_BUDGET = 120_000;

function formatRow(row: Row): string {
  const body = row.content?.trim() ?? '';
  if (row.role === 'tool') {
    // Tool rows are already stored as a one-line summary (e.g. "$ Edit: a.ts").
    return `[tool] ${body}`;
  }
  return `[${row.role}] ${row.created_at}\n${body}`;
}

/**
 * Returns the transcript, or null if the session doesn't exist. Includes
 * user / assistant / tool messages (tool rows are pre-summarized one-liners),
 * skipping worker-mirror rows (source_message_id set). When the session is
 * larger than the budget the OLDEST messages are dropped (recent work — the
 * results — is what a summary needs most), and `truncated` is set.
 */
export function readSessionTranscript(
  sessionId: string,
  opts: { limit?: number; db?: Database } = {},
): SessionTranscriptResult | null {
  const db = opts.db ?? getDb();
  const meta = db
    .prepare(
      `SELECT s.title AS title, p.name AS project_name
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as { title: string | null; project_name: string | null } | undefined;
  if (!meta) return null;

  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );

  const rows = db
    .prepare(
      `SELECT role, content, created_at
       FROM messages
       WHERE session_id = ?
         AND source_message_id IS NULL
         AND role IN ('user', 'assistant', 'tool')
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as Row[];

  // Keep the most recent `limit` messages, then trim oldest-first to the char
  // budget. We walk from newest backward so the kept window is the tail.
  const windowed = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  const kept: Row[] = [];
  let used = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const piece = formatRow(windowed[i]);
    if (used + piece.length > CHAR_BUDGET && kept.length > 0) break;
    used += piece.length + 2;
    kept.push(windowed[i]);
  }
  kept.reverse();

  const truncated = kept.length < rows.length;
  const text = kept.map(formatRow).join('\n\n');

  return {
    sessionId,
    title: meta.title,
    projectName: meta.project_name,
    includedMessages: kept.length,
    totalMessages: rows.length,
    truncated,
    text,
  };
}

export interface SessionListItem {
  id: string;
  title: string | null;
  projectName: string | null;
  agent: string;
  messageCount: number;
  updatedAt: string;
}

/** Recent non-bot sessions, newest first — so a bot can help the user pick an id. */
export function listRecentSessions(
  opts: { limit?: number; db?: Database } = {},
): SessionListItem[] {
  const db = opts.db ?? getDb();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 30)), 200);
  return db
    .prepare(
      `SELECT s.id AS id, s.title AS title, p.name AS project_name,
              s.agent AS agent, s.updated_at AS updated_at,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.session_id = s.id AND m.source_message_id IS NULL) AS message_count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.bot_kind IS NULL
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((r) => {
      const row = r as {
        id: string;
        title: string | null;
        project_name: string | null;
        agent: string;
        updated_at: string;
        message_count: number;
      };
      return {
        id: row.id,
        title: row.title,
        projectName: row.project_name,
        agent: row.agent,
        messageCount: row.message_count,
        updatedAt: row.updated_at,
      };
    });
}
