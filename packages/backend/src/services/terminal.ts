// Interactive terminal sessions backed by node-pty. One live shell per
// pinloom session, spawned in the session's project cwd. The pty is kept
// alive across websocket disconnects (page reloads, session-tab switches)
// and only reaped after an idle window — on reconnect we replay a bounded
// scrollback buffer so the terminal looks continuous. This is deliberately
// separate from the broadcast ws/hub (which is one-way server→client); a
// terminal needs to read client keystrokes too.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { getDb } from '../db/connection.js';

const SCROLLBACK_BYTES = 200 * 1024;
const IDLE_REAP_MS = 10 * 60 * 1000;

interface TerminalSession {
  pty: IPty;
  buffer: string;
  idleTimer: NodeJS.Timeout | null;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
}

const sessions = new Map<string, TerminalSession>();

function loadCwd(sessionId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT p.cwd
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as { cwd: string } | undefined;
  return row?.cwd ?? null;
}

function cleanEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export interface TerminalHandle {
  /** Scrollback snapshot to replay into the freshly attached client. */
  buffer: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Client socket closed — keep the pty alive but arm the idle reaper. */
  detach(): void;
}

/**
 * Attach a websocket consumer to the session's terminal, spawning the
 * shell on first attach. The data/exit callbacks are wired synchronously
 * with the buffer snapshot so no output is lost between replay and live
 * streaming. Returns null if the session has no resolvable cwd.
 */
export function attachTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): TerminalHandle | null {
  let session = sessions.get(sessionId);

  if (!session) {
    const projectCwd = loadCwd(sessionId);
    if (projectCwd === null) return null;
    // A deleted/moved project dir would make pty.spawn produce a dead shell
    // with no output — fall back to home and tell the user why.
    let cwd = projectCwd;
    let notice = '';
    if (!existsSync(cwd)) {
      notice = `\r\n[pinloom] project directory not found:\r\n  ${cwd}\r\nopened a shell in your home directory instead.\r\n\r\n`;
      cwd = homedir();
    }
    // $SHELL is virtually always set on macOS/Linux; bash is the safer
    // fallback than zsh when it isn't (more universally present on Linux).
    const shell = process.env.SHELL || 'bash';
    const child = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: cleanEnv(),
    });
    const created: TerminalSession = {
      pty: child,
      buffer: notice,
      idleTimer: null,
      onData: null,
      onExit: null,
    };
    child.onData((d) => {
      created.buffer = (created.buffer + d).slice(-SCROLLBACK_BYTES);
      created.onData?.(d);
    });
    child.onExit(({ exitCode }) => {
      created.onExit?.(exitCode);
      if (created.idleTimer) clearTimeout(created.idleTimer);
      sessions.delete(sessionId);
    });
    sessions.set(sessionId, created);
    session = created;
  } else {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try {
      session.pty.resize(cols, rows);
    } catch {
      // pty may have just exited; ignore
    }
  }

  const bound = session;
  const snapshot = bound.buffer;
  bound.onData = onData;
  bound.onExit = onExit;

  return {
    buffer: snapshot,
    write(data: string) {
      try {
        bound.pty.write(data);
      } catch {
        // best-effort
      }
    },
    resize(c: number, r: number) {
      try {
        bound.pty.resize(c, r);
      } catch {
        // best-effort
      }
    },
    detach() {
      bound.onData = null;
      bound.onExit = null;
      if (bound.idleTimer) clearTimeout(bound.idleTimer);
      bound.idleTimer = setTimeout(() => {
        try {
          bound.pty.kill();
        } catch {
          // best-effort
        }
        sessions.delete(sessionId);
      }, IDLE_REAP_MS);
    },
  };
}

export function killTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    session.pty.kill();
  } catch {
    // best-effort
  }
  sessions.delete(sessionId);
}
