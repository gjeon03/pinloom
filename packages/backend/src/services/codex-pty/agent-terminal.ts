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
import { cleanChildEnv } from '../child-env.js';
import { buildSessionLaunchInput, emitRunStatus, emitWorkerStatusIfMember } from '../runner.js';
import { broadcast } from '../../ws/hub.js';

// Emit `started` so a codex terminal session shows as running (tab dot + bell
// In progress); the rollout poller's `finished` (transcript-capture) clears it
// per turn. Unlike claude, codex has no Stop hook, so turnInFlight is never
// reset — guarding on it would emit `started` only ONCE per session. It's not
// read for gating anyway (codex dispatch waits on awaitCodexTurn), so we emit
// unconditionally; a duplicate `started` is a frontend no-op (idempotent).
function beginCodexTurn(session: { turnInFlight: boolean }, sessionId: string): void {
  session.turnInFlight = true;
  emitRunStatus(sessionId, 'started');
}
import { submitToTui } from '../claude-pty/tui-input.js';
import { buildCodexLaunch, codexHomeFor, type BuiltCodexLaunch } from './launch-spec.js';
import { startCodexCapture, stopCodexCapture, awaitCodexTurn } from './transcript-capture.js';

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
  /** A turn is running (set on the human's Enter). */
  turnInFlight: boolean;
  /** null = idle; 'dispatch' while an orchestrator drives this worker's TUI. */
  lockedBy: 'human' | 'dispatch' | null;
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

// Drop pinloom's own runtime vars (PORT etc.) from the agent shell — see
// services/child-env.ts.
const cleanEnv = cleanChildEnv;

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
    lockedBy: null,
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
      // While a dispatch drives this worker, human keystrokes are locked out
      // (the client shows a "busy" overlay via the terminal_lock event).
      if (bound.lockedBy === 'dispatch') return;
      // An Enter submits a turn — flag it so a dispatch waits for it.
      if (data.includes('\r') || data.includes('\n')) beginCodexTurn(bound, sessionId);
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

// ─── Orchestrator dispatch into a codex worker terminal (teams) ───

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CodexDispatchResult = { ok: true; reply: string } | { ok: false; error: string };

// Serialize dispatches per worker so two asks can't interleave on one TUI.
const dispatchChains = new Map<string, Promise<unknown>>();
function withCodexDispatchLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = dispatchChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  dispatchChains.set(sessionId, tail);
  void tail.finally(() => {
    if (dispatchChains.get(sessionId) === tail) dispatchChains.delete(sessionId);
  });
  return next;
}

function setCodexLock(
  session: CodexTerminalSession,
  sessionId: string,
  driver: 'human' | 'dispatch' | null,
): void {
  session.lockedBy = driver;
  broadcast(`session:${sessionId}`, {
    type: 'terminal_lock',
    sessionId,
    locked: driver === 'dispatch',
  });
}

/** Whether a session has a live codex terminal lock owner (for the UI overlay). */
export function codexTerminalLock(sessionId: string): 'human' | 'dispatch' | null {
  return sessions.get(sessionId)?.lockedBy ?? null;
}

// Wait for the codex TUI output to go quiet before injecting, so keystrokes land
// in a settled input box rather than mid-redraw (mirrors the claude path).
const TUI_QUIET_MS = 400;
const TUI_QUIET_CAP_MS = 5_000;
async function waitCodexQuiescent(session: CodexTerminalSession, signal: AbortSignal): Promise<void> {
  const start = Date.now();
  while (!signal.aborted) {
    if (Date.now() - session.lastDataAt >= TUI_QUIET_MS) return;
    if (Date.now() - start >= TUI_QUIET_CAP_MS) return;
    await sleep(80);
  }
}

/**
 * Drive a codex worker session with an orchestrator prompt and return its reply.
 * Serialized per worker. Cold-starts with the prompt SEEDED via the positional
 * arg (codex auto-runs it — reliable); a live worker is injected into after the
 * TUI settles. The reply is the rollout's task_complete.last_agent_message,
 * surfaced by awaitCodexTurn.
 */
export function dispatchToCodexWorker(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<CodexDispatchResult> {
  return withCodexDispatchLock(sessionId, async () => {
    // Paint the canvas edge yellow for the duration of the dispatched turn —
    // terminal workers bypass the runner, so isAiRunning never sees them.
    emitWorkerStatusIfMember(sessionId, true);
    try {
      const existing = sessions.get(sessionId);
      if (!existing) {
        // Cold start: arm the turn waiter AFTER spawn (capture starts in spawn),
        // then await the seeded turn's completion.
        const spawned = await spawnCodexTerminal(sessionId, 120, 40, text);
        if ('reason' in spawned) return { ok: false, error: spawned.reason };
        setCodexLock(spawned, sessionId, 'dispatch');
        beginCodexTurn(spawned, sessionId);
        try {
          const reply = await awaitCodexTurn(sessionId, signal, timeoutMs);
          return { ok: true, reply };
        } finally {
          if (sessions.get(sessionId) === spawned) setCodexLock(spawned, sessionId, null);
        }
      }
      // Settled worker: lock out the human, wait for the TUI to settle, arm the
      // turn waiter, then inject so the next completed turn is ours.
      setCodexLock(existing, sessionId, 'dispatch');
      try {
        await waitCodexQuiescent(existing, signal);
        const turn = awaitCodexTurn(sessionId, signal, timeoutMs);
        beginCodexTurn(existing, sessionId);
        await submitToTui(existing.pty, text);
        const reply = await turn;
        return { ok: true, reply };
      } finally {
        if (sessions.get(sessionId) === existing) setCodexLock(existing, sessionId, null);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      emitWorkerStatusIfMember(sessionId, false);
    }
  });
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
