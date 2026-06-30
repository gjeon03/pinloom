// Interactive terminals backed by node-pty. Terminals are per-project (a
// project can hold several — the bottom panel adds them with "+"), each
// keyed by `${projectId}::${localId}` and spawned in the project cwd. The
// pty stays alive across every websocket disconnect (reload, tab switch,
// bottom-panel collapse) until the user explicitly closes the tab or the
// backend shuts down. On reconnect a bounded scrollback buffer is replayed
// so it looks continuous. Host-resource bounds come from MAX_TERMINALS, not
// from a time-based reaper — a long-running `pnpm dev` that the user has
// collapsed out of view must survive an open-ended AI chat window without
// being killed underneath them.
//
// Separate from ws/hub (broadcast-only) because a terminal also reads
// client keystrokes.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { cleanChildEnv } from './child-env.js';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { getDb } from '../db/connection.js';

const SCROLLBACK_BYTES = 200 * 1024;
// Ceiling on concurrent live terminals across all projects — each is a real
// shell process plus scrollback, so this bounds host resources if something
// (a bug, a runaway client) tries to spawn without limit. Far above any
// realistic hand-opened count.
export const MAX_TERMINALS = 50;

interface TerminalSession {
  pty: IPty;
  buffer: string;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  // Bumped on every attach so a superseded consumer's detach() is a no-op
  // for callback-clearing — otherwise a second socket attaching to the same
  // terminal could have its callbacks wiped by the first socket's close.
  attachId: number;
}

const sessions = new Map<string, TerminalSession>();
let attachSeq = 0;

function terminalKey(projectId: string, localId: string): string {
  return `${projectId}::${localId}`;
}

function loadProjectCwd(projectId: string): string | null {
  const row = getDb()
    .prepare('SELECT cwd FROM projects WHERE id = ?')
    .get(projectId) as { cwd: string } | undefined;
  return row?.cwd ?? null;
}

// Drop pinloom's own runtime vars (PORT etc.) so the user's shell behaves like
// a plain terminal — see services/child-env.ts.
const cleanEnv = cleanChildEnv;

export interface TerminalHandle {
  /** Scrollback snapshot to replay into the freshly attached client. */
  buffer: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Client socket closed — keep the pty alive but arm the idle reaper. */
  detach(): void;
}

export type AttachResult =
  | { ok: true; handle: TerminalHandle }
  | { ok: false; reason: 'no-cwd' | 'capped' };

/**
 * Attach a websocket consumer to a project terminal, spawning the shell on
 * first attach. The data/exit callbacks are wired synchronously with the
 * buffer snapshot so no output is lost between replay and live streaming.
 * Returns null if the project has no resolvable cwd.
 */
export function attachTerminal(
  projectId: string,
  localId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): AttachResult {
  const key = terminalKey(projectId, localId);
  let session = sessions.get(key);

  if (!session) {
    // Reattaching to an existing terminal never counts against the cap; only
    // spawning a brand-new one does.
    if (sessions.size >= MAX_TERMINALS) return { ok: false, reason: 'capped' };
    const projectCwd = loadProjectCwd(projectId);
    if (projectCwd === null) return { ok: false, reason: 'no-cwd' };
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
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // FORCE TERM to match what xterm.js actually emulates. cleanEnv() copies
      // the backend's process.env, which may carry an inherited TERM (the shell
      // that launched `pnpm start`, tmux/screen, or none under launchd → the
      // node-pty `name` default). A mismatched TERM makes terminfo-heavy TUIs
      // (nvim) mis-render — blank screen in the panel. xterm-256color +
      // truecolor is correct for xterm.js.
      env: { ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const created: TerminalSession = {
      pty: child,
      buffer: notice,
      onData: null,
      onExit: null,
      attachId: 0,
    };
    child.onData((d) => {
      created.buffer = (created.buffer + d).slice(-SCROLLBACK_BYTES);
      created.onData?.(d);
    });
    child.onExit(({ exitCode }) => {
      created.onExit?.(exitCode);
      sessions.delete(key);
    });
    sessions.set(key, created);
    session = created;
  } else {
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
  const myAttachId = (bound.attachId = ++attachSeq);

  const handle: TerminalHandle = {
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
      // A newer consumer has taken over this terminal — let it keep the pty.
      if (bound.attachId !== myAttachId) return;
      // Disconnecting the socket only severs the consumer callbacks; the
      // pty (and whatever is running inside it) keeps going until the user
      // closes the tab via killTerminal() or the backend shuts down.
      bound.onData = null;
      bound.onExit = null;
    },
  };
  return { ok: true, handle };
}

export function killTerminal(projectId: string, localId: string): void {
  const key = terminalKey(projectId, localId);
  const session = sessions.get(key);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {
    // best-effort
  }
  sessions.delete(key);
}

/**
 * Tear down every live terminal on backend shutdown. Without this, the shells
 * (and any dev server running inside them) are merely reparented when the node
 * process exits — the kernel's hangup-on-master-close only reaches each pty's
 * foreground process group, so a backgrounded `server &` would leak.
 *
 * We SIGHUP the shell first: an interactive shell hangs up *all* of its jobs
 * (foreground and background) on HUP. After a short grace period anything still
 * alive gets a process-group SIGKILL. A process that deliberately ignores
 * SIGHUP / daemonizes itself can still survive — that's inherent.
 */
export async function killAllTerminals(): Promise<void> {
  const ptys = [...sessions.values()].map((s) => s.pty);
  sessions.clear();
  if (ptys.length === 0) return;

  for (const p of ptys) {
    try {
      p.kill('SIGHUP');
    } catch {
      // already exited
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 400));

  for (const p of ptys) {
    try {
      // Negative pid → the whole process group (node-pty setsid's the shell,
      // so its pid is its group leader).
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        // gone
      }
    }
  }
}
