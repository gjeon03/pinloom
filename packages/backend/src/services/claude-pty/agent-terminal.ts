// Per-SESSION interactive agent terminal: spawns the real `claude` TUI in the
// session's cwd with the session's full launch spec (system prompt, MCP wiring,
// model/effort, resume) and streams its raw output to an xterm.js client. Unlike
// terminal.ts (a plain per-PROJECT shell), this is keyed by sessionId and runs
// the agent CLI; the human types directly into the TUI so streaming + every
// native slash command (/model, /effort, /clear, …) come for free.
//
// The pty survives WS disconnects (reload, tab switch) until the session's tab is
// closed or the backend shuts down — a long agent turn must not be killed when
// the client momentarily detaches. Turn completion still flows through the shared
// Stop-hook server (used by the background transcript capture + team dispatch).
//
// Single-driver write lock: a worker session can be driven by the human OR by an
// orchestrator dispatch, never both at once. `lockedBy` gates writes so a
// dispatch (Phase 5) can block human keystrokes while it drives, and vice-versa.

import { existsSync } from 'node:fs';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { buildSessionLaunchInput } from '../runner.js';
import { buildClaudeLaunch, type BuiltClaudeLaunch } from './launch-spec.js';
import { getStopHookServer } from './shared-server.js';

const CLAUDE_BIN = process.env.PINLOOM_CLAUDE_BIN ?? 'claude';
const SCROLLBACK_BYTES = 200 * 1024;
// Combined with terminal.ts's project shells these share the host's pty/RAM
// budget; keep the ceiling modest. (Plan m3: ideally one combined cap.)
const MAX_AGENT_TERMINALS = 30;

/** Who currently owns the single write channel into the TUI. */
export type TerminalDriver = 'human' | 'dispatch';

interface AgentTerminalSession {
  pty: IPty;
  launch: BuiltClaudeLaunch;
  /** Claude session id once known (from the transcript / resume token). */
  sessionId: string;
  buffer: string;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  attachId: number;
  /** null = idle; otherwise the current single driver (see write lock). */
  lockedBy: TerminalDriver | null;
}

const sessions = new Map<string, AgentTerminalSession>();
let attachSeq = 0;

function cleanEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export interface AgentTerminalHandle {
  /** Scrollback snapshot to replay into the freshly attached client. */
  buffer: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Client socket closed — keep the pty alive. */
  detach(): void;
}

export type AttachAgentResult =
  | { ok: true; handle: AgentTerminalHandle }
  | { ok: false; reason: 'no-session' | 'capped' | 'no-cwd' };

/**
 * Attach a websocket consumer to a session's agent terminal, spawning the
 * `claude` TUI on first attach. Idempotent across reconnects (the pty persists).
 */
export async function attachAgentTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<AttachAgentResult> {
  let session = sessions.get(sessionId);

  if (!session) {
    // Reattaching never counts against the cap; only a brand-new spawn does.
    if (sessions.size >= MAX_AGENT_TERMINALS) return { ok: false, reason: 'capped' };

    const launchInput = buildSessionLaunchInput(sessionId);
    if (!launchInput) return { ok: false, reason: 'no-session' };
    if (!existsSync(launchInput.cwd)) return { ok: false, reason: 'no-cwd' };

    const server = await getStopHookServer();
    const launch = buildClaudeLaunch(
      {
        systemPrompt: launchInput.systemPrompt,
        model: launchInput.model ?? undefined,
        reasoningEffort: launchInput.reasoningEffort ?? undefined,
        resume: launchInput.resume,
        mcpServers: launchInput.mcpServers,
        // Human drives the first turn by typing — no positional seed.
        initialText: null,
      },
      server.url(),
    );

    const child = pty.spawn(CLAUDE_BIN, launch.args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: launchInput.cwd,
      env: cleanEnv(),
    });

    const created: AgentTerminalSession = {
      pty: child,
      launch,
      sessionId: launchInput.resume ?? '',
      buffer: '',
      onData: null,
      onExit: null,
      attachId: 0,
      lockedBy: null,
    };
    child.onData((d) => {
      created.buffer = (created.buffer + d).slice(-SCROLLBACK_BYTES);
      created.onData?.(d);
    });
    child.onExit(({ exitCode }) => {
      created.onExit?.(exitCode);
      sessions.delete(sessionId);
      created.launch.cleanup();
    });
    sessions.set(sessionId, created);
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

  const handle: AgentTerminalHandle = {
    buffer: snapshot,
    write(data: string) {
      // While a dispatch is driving this worker, human keystrokes are locked
      // out (the client shows a "busy" overlay). Dispatch writes go through
      // writeAsDispatch(), not this consumer handle.
      if (bound.lockedBy === 'dispatch') return;
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
      // A newer consumer superseded this one — let it keep the pty.
      if (bound.attachId !== myAttachId) return;
      bound.onData = null;
      bound.onExit = null;
    },
  };
  return { ok: true, handle };
}

/** Whether a session has a live agent terminal. */
export function hasAgentTerminal(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Current write-lock owner, or null if idle. */
export function agentTerminalLock(sessionId: string): TerminalDriver | null {
  return sessions.get(sessionId)?.lockedBy ?? null;
}

export function killAgentTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {
    // best-effort
  }
  session.launch.cleanup();
  sessions.delete(sessionId);
}

/**
 * Tear down every agent terminal on backend shutdown — SIGHUP the TUI (hangs up
 * its jobs), then SIGKILL the process group after a grace period. Mirrors
 * terminal.ts's killAllTerminals so a backgrounded agent turn can't leak.
 */
export async function killAllAgentTerminals(): Promise<void> {
  const live = [...sessions.values()];
  sessions.clear();
  if (live.length === 0) return;

  for (const s of live) {
    try {
      s.pty.kill('SIGHUP');
    } catch {
      // already exited
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const s of live) {
    try {
      process.kill(-s.pty.pid, 'SIGKILL');
    } catch {
      try {
        s.pty.kill('SIGKILL');
      } catch {
        // gone
      }
    }
    s.launch.cleanup();
  }
}
