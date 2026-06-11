// Per-session interactive CODEX terminal — the codex analog of
// claude-pty/agent-terminal.ts. Spawns the real `codex` TUI in the session's cwd
// with its launch spec (system prompt via AGENTS.md, MCP wiring, model/effort,
// resume) and streams raw output to an xterm.js client. The human types directly.
//
// Phase 1 scope: the PTY lifecycle (spawn / attach / teardown / kill) so codex
// renders as a live terminal. Capture (rollout-tail → messages rows) and teams
// dispatch are added in later phases; the `turnInFlight` flag + spawn dedup are
// kept now for forward-compat. This file is intentionally a focused parallel of
// the claude lifecycle (kept separate so the claude path stays untouched).

import { existsSync, rmSync } from 'node:fs';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { buildSessionLaunchInput } from '../runner.js';
import { buildCodexLaunch, codexHomeFor, type BuiltCodexLaunch } from './launch-spec.js';
import { startCodexCapture, stopCodexCapture } from './transcript-capture.js';

const codexBin = () => process.env.PINLOOM_CODEX_BIN ?? 'codex';
const SCROLLBACK_BYTES = 200 * 1024;
const MAX_CODEX_TERMINALS = 30;

interface CodexTerminalSession {
  pty: IPty;
  launch: BuiltCodexLaunch;
  buffer: string;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  attachId: number;
  lastDataAt: number;
  /** A turn is running (set on the human's Enter; used by later dispatch phases). */
  turnInFlight: boolean;
}

export interface CodexAttachResult {
  ok: true;
  handle: CodexTerminalHandle;
}
export interface CodexAttachFail {
  ok: false;
  reason: 'no-session' | 'no-cwd' | 'capped';
}
export interface CodexTerminalHandle {
  buffer: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

const sessions = new Map<string, CodexTerminalSession>();
const spawning = new Map<
  string,
  Promise<CodexTerminalSession | { reason: 'no-session' | 'no-cwd' }>
>();
let attachSeq = 0;

function cleanEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export async function spawnCodexTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  seedText: string | null = null,
): Promise<CodexTerminalSession | { reason: 'no-session' | 'no-cwd' }> {
  const launchInput = buildSessionLaunchInput(sessionId);
  if (!launchInput) return { reason: 'no-session' };
  if (!existsSync(launchInput.cwd)) return { reason: 'no-cwd' };

  const launch = buildCodexLaunch({
    sessionId,
    cwd: launchInput.cwd,
    systemPrompt: launchInput.systemPrompt,
    model: launchInput.model,
    reasoningEffort: launchInput.reasoningEffort,
    resume: launchInput.resume,
    mcpServers: launchInput.mcpServers,
    initialText: seedText,
  });

  const child = pty.spawn(codexBin(), launch.args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: launchInput.cwd,
    env: { ...cleanEnv(), CODEX_HOME: launch.codexHome },
  });

  const created: CodexTerminalSession = {
    pty: child,
    launch,
    buffer: '',
    onData: null,
    onExit: null,
    attachId: 0,
    lastDataAt: Date.now(),
    turnInFlight: false,
  };
  child.onData((d) => {
    created.buffer = (created.buffer + d).slice(-SCROLLBACK_BYTES);
    created.lastDataAt = Date.now();
    created.onData?.(d);
  });
  child.onExit(({ exitCode }) => {
    created.onExit?.(exitCode);
    teardownCodexSession(sessionId);
    created.onExit = null;
  });
  sessions.set(sessionId, created);
  // Persist this session's turns to the messages table in the background by
  // polling the rollout file (history / pins / notifications / teams).
  startCodexCapture(sessionId, launch.codexHome, launchInput.resume);
  return created;
}

/** Common teardown for a codex session: drop bookkeeping, free transient files. */
function teardownCodexSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  stopCodexCapture(sessionId);
  if (session) session.launch.cleanup();
}

export async function attachCodexTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<CodexAttachResult | CodexAttachFail> {
  let session = sessions.get(sessionId);

  if (!session) {
    let inflight = spawning.get(sessionId);
    if (!inflight) {
      if (sessions.size + spawning.size >= MAX_CODEX_TERMINALS) {
        return { ok: false, reason: 'capped' };
      }
      inflight = spawnCodexTerminal(sessionId, cols, rows);
      spawning.set(sessionId, inflight);
      inflight.finally(() => spawning.delete(sessionId));
    }
    const result = await inflight;
    if ('reason' in result) return { ok: false, reason: result.reason };
    session = result;
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

  const handle: CodexTerminalHandle = {
    buffer: snapshot,
    write(data: string) {
      // An Enter submits a turn — flag it (used by later dispatch phases).
      if (data.includes('\r') || data.includes('\n')) bound.turnInFlight = true;
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
      if (bound.attachId !== myAttachId) return;
      bound.onData = null;
      bound.onExit = null;
    },
  };
  return { ok: true, handle };
}

export function hasCodexTerminal(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function killCodexTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {
    // best-effort
  }
  teardownCodexSession(sessionId);
}

/** Remove a session's stable CODEX_HOME — call on session deletion. */
export function removeCodexHome(sessionId: string): void {
  try {
    rmSync(codexHomeFor(sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export async function killAllCodexTerminals(): Promise<void> {
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
