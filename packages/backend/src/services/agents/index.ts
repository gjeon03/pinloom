import type { AgentKind } from '@pinloom/shared';
import { getDb } from '../../db/connection.js';
import { claudeAdapter } from './claude-adapter.js';
import { claudeRemoteAdapter } from './claude-remote-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import type { AgentAdapter } from './types.js';

// PR 3 promoted remote-control from a process-wide env var to a per-session
// flag in `sessions.remote_control`. The env var is still honored as the
// default for newly-created sessions (see routes/sessions.ts), but the
// stored column is what `getAgentAdapter` reads here — sessions stay on
// the adapter they were created with even if the env var is later
// flipped, and the user can toggle individual sessions via PATCH.
//
// One DB lookup per `getAgentAdapter` call. Single-process SQLite +
// session_id-keyed primary key index = sub-millisecond, well below the
// noise floor of the adapter itself.
//
// Throws (rather than silently returning the local adapter) when a
// sessionId is provided but the row doesn't exist. The runner caches
// adapter choice for a single `runAssistant`, but other callers might
// look up a session that just got deleted; a loud failure is better
// than silently routing to the wrong adapter.
function isRemoteControlEnabled(sessionId: string): boolean {
  const row = getDb()
    .prepare('SELECT remote_control FROM sessions WHERE id = ?')
    .get(sessionId) as { remote_control: number } | undefined;
  if (!row) {
    throw new Error(`getAgentAdapter: session ${sessionId} not found`);
  }
  return row.remote_control === 1;
}

export function getAgentAdapter(agent: AgentKind, sessionId?: string): AgentAdapter {
  switch (agent) {
    case 'codex':
      return codexAdapter;
    case 'claude':
    default:
      if (sessionId && isRemoteControlEnabled(sessionId)) {
        return claudeRemoteAdapter;
      }
      return claudeAdapter;
  }
}

export type { AgentAdapter, AgentRun, AgentRunArgs, NormalizedEvent } from './types.js';
