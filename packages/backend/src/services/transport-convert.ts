// Convert a session between the SDK (structured ChatView) and terminal (live
// TUI) transports while keeping the CONVERSATION. Both transports drive the
// same underlying CLIs, so the agent-side history is portable:
//
//  - claude: SDK and TUI share ~/.claude/projects/<cwd>/<session>.jsonl, so a
//    plain `--resume <id>` continues the conversation either way. The only
//    bookkeeping is seeding the terminal capture cursor with the transcript's
//    current tail uuid so capture doesn't re-fold pre-conversion history.
//  - codex: the SDK (codex exec) writes its rollout under ~/.codex/sessions
//    while terminal sessions use a per-session CODEX_HOME — so conversion
//    copies the rollout file across and seeds the line-count cursor.
//
// Verified live (spike, both agents): SDK→terminal continuity, zero duplicate
// rows, and claude round-trips terminal→SDK cleanly.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { isAiRunning } from './runner.js';
import { readLines } from './claude-pty/transcript.js';
import {
  hasAgentTerminal,
  killAgentTerminal,
} from './claude-pty/agent-terminal.js';
import {
  hasCodexTerminal,
  killCodexTerminal,
} from './codex-pty/agent-terminal.js';
import { codexHomeFor } from './codex-pty/launch-spec.js';

export class TransportConvertError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'TransportConvertError';
  }
}

interface SessionRow {
  id: string;
  agent: string | null;
  transport: string | null;
  agent_session_id: string | null;
}

// Walk a sessions tree for rollout-*.jsonl files. codex embeds the session
// uuid in the filename, so a name match is sufficient and cheap.
function findRollout(root: string, agentSessionId: string): string | null {
  let hit: string | null = null;
  const walk = (dir: string): void => {
    if (hit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (hit) return;
      const p = path.join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (
        e.startsWith('rollout-') &&
        e.endsWith('.jsonl') &&
        e.includes(agentSessionId)
      ) {
        hit = p;
      }
    }
  };
  walk(root);
  return hit;
}

// Copy a rollout between session stores, preserving the YYYY/MM/DD date path
// so codex's own discovery (and our terminal capture) finds it.
function copyRollout(src: string, fromRoot: string, toRoot: string): string {
  const rel = path.relative(fromRoot, src);
  const dst = path.join(toRoot, rel);
  mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  copyFileSync(src, dst);
  return dst;
}

const userCodexSessions = () =>
  path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'sessions');

/**
 * Flip a session's transport, carrying the conversation across. Returns the
 * raw updated session row (route maps it through toSession).
 *
 * If the agent-side history can't be located (e.g. a codex SDK orchestrator
 * whose temp CODEX_HOME is gone), the resume token + cursor are cleared so the
 * converted session starts a FRESH agent conversation instead of failing on a
 * dangling resume — pinloom's own message history is untouched either way.
 */
export function convertSessionTransport(
  sessionId: string,
  to: 'sdk' | 'terminal',
): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id, agent, transport, agent_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!row) throw new TransportConvertError('session not found', 404);
  const agent = row.agent === 'codex' ? 'codex' : 'claude';
  const current = row.transport ?? 'sdk';
  if (current === to) {
    throw new TransportConvertError(`session is already on the ${to} transport`);
  }
  if (current === 'pty' || (to !== 'sdk' && to !== 'terminal')) {
    throw new TransportConvertError(`unsupported conversion ${current} → ${to}`);
  }
  if (isAiRunning(sessionId)) {
    throw new TransportConvertError(
      'a run is in flight — wait for it to finish before converting',
      409,
    );
  }
  // A live TUI holds the agent process + capture for the old transport.
  if (hasAgentTerminal(sessionId)) killAgentTerminal(sessionId);
  if (hasCodexTerminal(sessionId)) killCodexTerminal(sessionId);

  let clearResume = false;
  let cursor: string | null = null;

  if (agent === 'claude') {
    if (to === 'terminal') {
      // Seed the capture cursor at the transcript tail so the terminal
      // capture only folds post-conversion turns.
      const transcript = row.agent_session_id
        ? findClaudeTranscript(row.agent_session_id)
        : null;
      if (transcript) {
        const lines = readLines(transcript);
        for (let i = lines.length - 1; i >= 0; i--) {
          const uuid = (lines[i] as { uuid?: string }).uuid;
          if (uuid) {
            cursor = uuid;
            break;
          }
        }
      }
      if (!transcript) clearResume = true;
    }
    // terminal → sdk: nothing to move — the transcript is shared and the SDK
    // resumes from the same session id. The capture cursor is terminal-only
    // state; it gets re-seeded on the next conversion back.
  } else {
    // codex: move the rollout file between the per-session home and ~/.codex.
    const sessionHome = path.join(codexHomeFor(sessionId), 'sessions');
    if (to === 'terminal') {
      const src = row.agent_session_id
        ? findRollout(userCodexSessions(), row.agent_session_id)
        : null;
      if (src) {
        copyRollout(src, userCodexSessions(), sessionHome);
        cursor = String(
          readFileSync(src, 'utf8').split('\n').filter(Boolean).length,
        );
      } else {
        clearResume = true;
      }
    } else {
      // terminal → sdk: make the rollout discoverable in the user home so
      // `codex exec resume` can pick the thread up.
      const src = row.agent_session_id
        ? findRollout(sessionHome, row.agent_session_id)
        : null;
      if (src) {
        const rel = path.relative(sessionHome, src);
        if (!existsSync(path.join(userCodexSessions(), rel))) {
          copyRollout(src, sessionHome, userCodexSessions());
        }
      } else if (row.agent_session_id) {
        // No rollout to carry — resume would dangle.
        clearResume = true;
      }
    }
  }

  db.prepare(
    `UPDATE sessions SET
       transport = ?,
       last_captured_transcript_uuid = ?,
       agent_session_id = CASE WHEN ? THEN NULL ELSE agent_session_id END,
       claude_session_id = CASE WHEN ? THEN NULL ELSE claude_session_id END,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    to,
    cursor,
    clearResume ? 1 : 0,
    clearResume ? 1 : 0,
    new Date().toISOString(),
    sessionId,
  );
}

function findClaudeTranscript(agentSessionId: string): string | null {
  const root = path.join(homedir(), '.claude', 'projects');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of entries) {
    const cand = path.join(root, dir, `${agentSessionId}.jsonl`);
    if (existsSync(cand)) return cand;
  }
  return null;
}
