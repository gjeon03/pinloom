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
import { cleanChildEnv } from '../child-env.js';
import { buildSessionLaunchInput, emitRunStatus, emitWorkerStatusIfMember } from '../runner.js';
import { broadcast } from '../../ws/hub.js';
import {
  buildClaudeLaunch,
  preTrustClaudeCwd,
  type BuiltClaudeLaunch,
} from './launch-spec.js';
import { getStopHookServer } from './shared-server.js';
import { submitToTui } from './tui-input.js';
import {
  startCapture,
  stopCapture,
  linkClaudeSessionId,
  isRescanPending,
} from './transcript-capture.js';
import {
  listSessionFiles,
  discoverNewSessionFile,
  sessionIdOf,
} from './transcript.js';
import { getDb } from '../../db/connection.js';
import type { StopHookPayload } from './stop-hook-server.js';
import { createScrollback, type Scrollback } from '../scrollback.js';

// Read per spawn so tests can point it at a mock binary via env.
const claudeBin = () => process.env.PINLOOM_CLAUDE_BIN ?? 'claude';
const SCROLLBACK_BYTES = 200 * 1024;
// Combined with terminal.ts's project shells these share the host's pty/RAM
// budget; keep the ceiling modest. (Plan m3: ideally one combined cap.)
const MAX_AGENT_TERMINALS = 30;

/** Who currently owns the single write channel into the TUI. */
export type TerminalDriver = 'human' | 'dispatch';

interface AgentTerminalSession {
  pty: IPty;
  launch: BuiltClaudeLaunch;
  scrollback: Scrollback;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  attachId: number;
  /** null = idle; otherwise the current single driver (see write lock). */
  lockedBy: TerminalDriver | null;
  /** Last time the TUI produced output. */
  lastDataAt: number;
  /**
   * A turn is currently running (human or dispatch). Set when the human submits
   * (an Enter in their keystrokes) or a dispatch injects; cleared on the Stop
   * hook. Lets a dispatch wait for an in-flight human turn even before its output
   * starts streaming — which output-quiescence alone can't detect.
   */
  turnInFlight: boolean;
  /** Unregister the Stop listener that clears turnInFlight. */
  unregisterTurnTracker: () => void;
  /** Turns submitted so far (diagnostic for the #188 capture-failure signal). */
  turns: number;
  /** Aborts the background transcript-discovery watcher (#188 defense) on teardown. */
  discoverAbort: AbortController | null;
}

// Serializes dispatches per worker so two orchestrator asks can't interleave.
const dispatchChains = new Map<string, Promise<unknown>>();
function withDispatchLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = dispatchChains.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  dispatchChains.set(
    sessionId,
    next.catch(() => {}),
  );
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sessions = new Map<string, AgentTerminalSession>();
// In-flight spawns, so two near-simultaneous attaches for the same session
// dedupe onto one `claude` process instead of double-spawning (attach is async —
// there's an await between the existence check and the map set).
const spawning = new Map<string, Promise<AgentTerminalSession | { reason: 'no-session' | 'no-cwd' }>>();
let attachSeq = 0;

// Drop pinloom's own runtime vars (PORT etc.) from the agent shell — see
// services/child-env.ts.
const cleanEnv = cleanChildEnv;

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
async function spawnAgentTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  // When a dispatch cold-starts a worker, seed the first turn via the positional
  // arg (auto-runs) — injecting into a freshly-launched TUI is unreliable. The
  // human attach path leaves this null and types directly.
  seedText: string | null = null,
): Promise<AgentTerminalSession | { reason: 'no-session' | 'no-cwd' }> {
  const launchInput = buildSessionLaunchInput(sessionId);
  if (!launchInput) return { reason: 'no-session' };
  if (!existsSync(launchInput.cwd)) return { reason: 'no-cwd' };

  // Accept the folder-trust dialog before launch so a cold-start dispatch (no
  // human to click through it) doesn't hang, and fresh-project sessions start
  // clean. No-op once the cwd is already trusted.
  preTrustClaudeCwd(launchInput.cwd);

  const server = await getStopHookServer();
  const launch = buildClaudeLaunch(
    {
      systemPrompt: launchInput.systemPrompt,
      model: launchInput.model ?? undefined,
      reasoningEffort: launchInput.reasoningEffort ?? undefined,
      resume: launchInput.resume,
      mcpServers: launchInput.mcpServers,
      strictMcp: launchInput.strictMcp,
      initialText: seedText,
    },
    server.url(),
    { pinloomSessionId: sessionId },
  );

  // Snapshot existing transcripts BEFORE spawn so the #188 defense can spot the
  // one this fresh session creates (a resumed session already has a known id).
  const isFresh = !launchInput.resume;
  const beforeFiles = isFresh ? listSessionFiles(launchInput.cwd) : new Set<string>();

  const child = pty.spawn(claudeBin(), launch.args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: launchInput.cwd,
    env: cleanEnv(),
  });

  const created: AgentTerminalSession = {
    pty: child,
    launch,
    scrollback: createScrollback(SCROLLBACK_BYTES),
    onData: null,
    onExit: null,
    attachId: 0,
    lockedBy: null,
    lastDataAt: Date.now(),
    turnInFlight: false,
    unregisterTurnTracker: () => {},
    turns: 0,
    discoverAbort: null,
  };
  child.onData((d) => {
    created.scrollback.push(d);
    created.lastDataAt = Date.now();
    created.onData?.(d);
  });
  child.onExit(({ exitCode }) => {
    created.onExit?.(exitCode);
    teardownSession(sessionId);
    created.onExit = null;
  });
  // Clear turnInFlight whenever a turn completes (human or dispatch).
  created.unregisterTurnTracker = server.onStop(sessionId, () => {
    created.turnInFlight = false;
  });
  sessions.set(sessionId, created);
  // Persist this session's turns to the messages table in the background
  // (history / pins / notifications / teams). resume token seeds the agent id.
  void startCapture(sessionId, launchInput.resume);

  // DEFENSE (#188): the Stop-hook forwarder is normally the ONLY writer of
  // claude_session_id; if it dies (broken `node` in the app's PATH, a competing
  // wrapper hook) capture never links and every backend restart loses context.
  // As a net, watch the fs for the transcript this fresh session writes and link
  // it ourselves. Keyed discovery refuses if ambiguous (a sibling claude in the
  // same cwd), so it can never mis-link another session. Best-effort — the Stop
  // hook still wins the race when it works.
  if (isFresh) {
    created.discoverAbort = new AbortController();
    void discoverAndLink(sessionId, launchInput.cwd, beforeFiles, created);
  }
  return created;
}

/**
 * Background watcher for the #188 defense: wait for the fresh session's new
 * transcript to appear, then link its claude session id (idempotent — no-op if
 * the Stop hook already set it). Swallows the ambiguous/timeout/abort throws —
 * the Stop hook remains the primary path.
 */
async function discoverAndLink(
  sessionId: string,
  cwd: string,
  before: ReadonlySet<string>,
  session: AgentTerminalSession,
): Promise<void> {
  try {
    const file = await discoverNewSessionFile(cwd, before, {
      timeoutMs: 5 * 60_000,
      signal: session.discoverAbort?.signal,
    });
    linkClaudeSessionId(sessionId, sessionIdOf(file));
  } catch {
    // Timed out (no turn taken), aborted (torn down), or ambiguous (a sibling
    // claude in the same cwd) — best-effort. Diagnostic: a turn ran but we still
    // never linked an id → the exact #188 signal that went silent before.
    const linked = getDb()
      .prepare('SELECT claude_session_id AS c FROM sessions WHERE id = ?')
      .get(sessionId) as { c: string | null } | undefined;
    if (session.turns > 0 && !linked?.c && !session.discoverAbort?.signal.aborted) {
      console.warn(
        `[agent-terminal] ${sessionId}: ${session.turns} turn(s) ran but claude_session_id ` +
          `is still null — transcript capture is not linking (issue #188 signal).`,
      );
    }
  }
}

/** Common teardown for a session: stop capture, drop bookkeeping, free temp dir. */
function teardownSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  dispatchChains.delete(sessionId);
  stopCapture(sessionId);
  if (session) {
    session.unregisterTurnTracker();
    session.discoverAbort?.abort();
    session.launch.cleanup();
  }
}

// How long after a `started` we wait for any claude output before deciding the
// Enter was stray (claude echoes a real submit within ms, so silence here means
// no turn actually began). Generous so a slow first paint never false-clears.
const STRAY_ENTER_MS = 4000;

// Mark a turn as started on the false→true edge of turnInFlight, emitting a
// `started` run_activity so the session lights up as "running" (tab dot + the
// notification bell's In progress list) — terminal turns otherwise only ever
// emit `finished`, so they never showed as running. Paired with the capture's
// signalTurnComplete (`finished`).
//
// Self-heal a STRAY Enter (e.g. an empty submit / TUI navigation that starts no
// turn): such an Enter lights the dot but produces no Stop hook, so without this
// the dot stays stuck until some future real turn finishes. claude echoes a real
// submit immediately, so if NO output arrives within STRAY_ENTER_MS we clear the
// running state. A genuine long turn echoes right away → its dot stays on (this
// only fires when claude never reacted at all).
function beginTurn(session: AgentTerminalSession, sessionId: string): void {
  if (session.turnInFlight) return;
  session.turnInFlight = true;
  session.turns += 1;
  emitRunStatus(sessionId, 'started');
  const dataAtStart = session.lastDataAt;
  setTimeout(() => {
    if (session.turnInFlight && session.lastDataAt === dataAtStart) {
      session.turnInFlight = false;
      emitRunStatus(sessionId, 'finished');
    }
  }, STRAY_ENTER_MS).unref?.();
}

export async function attachAgentTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<AttachAgentResult> {
  let session = sessions.get(sessionId);

  if (!session) {
    // Dedupe concurrent attaches onto a single spawn (see `spawning`).
    let inflight = spawning.get(sessionId);
    if (!inflight) {
      // Reattaching never counts against the cap; only a brand-new spawn does.
      if (sessions.size + spawning.size >= MAX_AGENT_TERMINALS) {
        return { ok: false, reason: 'capped' };
      }
      inflight = spawnAgentTerminal(sessionId, cols, rows);
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
  const snapshot = bound.scrollback.snapshot();
  bound.onData = onData;
  bound.onExit = onExit;
  const myAttachId = (bound.attachId = ++attachSeq);

  const handle: AgentTerminalHandle = {
    buffer: snapshot,
    write(data: string) {
      // While a dispatch is driving this worker, human keystrokes are locked
      // out (the client shows a "busy" overlay).
      if (bound.lockedBy === 'dispatch') return;
      // An Enter in the human's keystrokes submits a turn — mark it in flight so
      // a dispatch waits for it (cleared on the turn's Stop hook). Heuristic, but
      // catches the "human just submitted, claude not yet streaming" window that
      // output-quiescence misses.
      if (data.includes('\r') || data.includes('\n')) beginTurn(bound, sessionId);
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
  teardownSession(sessionId);
}

// Idle agent-terminal reaper. A detached terminal keeps its claude TUI (~80MB)
// alive so a momentary disconnect doesn't kill a long turn — but with no time
// bound those linger: open a terminal, walk away, and the process survives until
// session delete or shutdown (worst case MAX_AGENT_TERMINALS × ~80MB). We reap
// ones that are detached (no attached client), NOT running a turn, and idle past
// the threshold. Safe because pinloom stores the claude session id and reopening
// relaunches with `--resume` — the full session restores; the only cost is a
// ~1-2s respawn on return. Default 30 min: with team mode a single dispatch can
// fan out N worker TUIs (each ~80MB + its MCP children), and workers sit idle
// between dispatches, so reclaiming them promptly keeps memory pressure down;
// the next dispatch cold-starts them via `--resume` transparently. Env-tunable.
const REAP_SWEEP_MS = 10 * 60_000;
function reapIdleMs(): number {
  const n = Number(process.env.PINLOOM_AGENT_TERMINAL_REAP_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000; // 30 min
}

/** Pure reap predicate (exported for tests): detached + no turn + idle. */
export function shouldReapTerminal(
  s: { onData: unknown; turnInFlight: boolean; lockedBy: unknown; lastDataAt: number },
  nowMs: number,
  idleMs: number,
): boolean {
  if (s.onData !== null) return false; // a client is attached — leave it
  if (s.turnInFlight) return false; // a turn is in flight — never interrupt
  if (s.lockedBy !== null) return false; // a driver holds the write lock
  return nowMs - s.lastDataAt >= idleMs; // idle long enough
}

/** Kill detached + idle + no-turn agent terminals. Returns the reaped ids. */
export function reapIdleAgentTerminals(nowMs: number, idleMs: number): string[] {
  const reaped: string[] = [];
  for (const [sessionId, s] of sessions) {
    if (!shouldReapTerminal(s, nowMs, idleMs)) continue;
    // Don't reap mid-rescan: capture is chasing a late-flushing reply, and
    // killing now would orphan it (teardown-vs-rescan gap).
    if (isRescanPending(sessionId)) continue;
    killAgentTerminal(sessionId);
    reaped.push(sessionId);
  }
  return reaped;
}

let reapTimer: ReturnType<typeof setInterval> | null = null;
export function startAgentTerminalReaper(): void {
  if (reapTimer) return;
  reapTimer = setInterval(() => {
    try {
      const reaped = reapIdleAgentTerminals(Date.now(), reapIdleMs());
      if (reaped.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[agent-terminal] reaped ${reaped.length} idle terminal(s)`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agent-terminal] reaper failed:', err instanceof Error ? err.message : err);
    }
  }, REAP_SWEEP_MS);
  reapTimer.unref?.();
}
export function stopAgentTerminalReaper(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}

/**
 * Tear down every agent terminal on backend shutdown — SIGHUP the TUI (hangs up
 * its jobs), then SIGKILL the process group after a grace period. Mirrors
 * terminal.ts's killAllTerminals so a backgrounded agent turn can't leak.
 */
export async function killAllAgentTerminals(): Promise<void> {
  const ids = [...sessions.keys()];
  const live = [...sessions.values()];
  sessions.clear();
  dispatchChains.clear();
  for (const id of ids) stopCapture(id);
  for (const s of live) {
    s.unregisterTurnTracker();
    s.discoverAbort?.abort();
  }
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

// ─── Orchestrator dispatch into a worker terminal (teams in terminal mode) ───

function setLock(
  session: AgentTerminalSession,
  sessionId: string,
  driver: TerminalDriver | null,
): void {
  session.lockedBy = driver;
  broadcast(`session:${sessionId}`, {
    type: 'terminal_lock',
    sessionId,
    locked: driver === 'dispatch',
  });
}

/** Resolve with the payload of the next Stop hook for this pinloom session. */
async function awaitNextStop(
  sessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<StopHookPayload> {
  const server = await getStopHookServer();
  return new Promise<StopHookPayload>((resolve, reject) => {
    let done = false;
    const unregister = server.onStop(sessionId, (payload) => {
      if (done) return;
      done = true;
      finish();
      resolve(payload);
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      finish();
      reject(new Error(`dispatch turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      if (done) return;
      done = true;
      finish();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    function finish() {
      unregister();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  });
}

/**
 * Wait until no turn is running on this worker (an in-flight human turn finishes)
 * so a dispatch doesn't read the human turn's Stop. turnInFlight is set on the
 * human's Enter and cleared on the Stop hook — more reliable than output
 * quiescence, which can't see a just-submitted turn that hasn't streamed yet.
 * Returns false if it gave up at the cap (a turn ran longer than the budget).
 */
async function waitTurnIdle(
  session: AgentTerminalSession,
  signal: AbortSignal,
  capMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (!signal.aborted) {
    if (!session.turnInFlight) return true;
    if (Date.now() - start >= capMs) return false;
    await sleep(100);
  }
  return false;
}

// After the prior turn's Stop fires, the worker's TUI is still redrawing its
// input box; keystrokes injected into that window get DROPPED (the prompt never
// submits and the turn silently does nothing — the terminal-team bug where a
// worker answered the cold-start turn but ignored every later dispatch). Wait for
// the pty output to go quiet first, mirroring node-session's pre-inject readiness
// wait (`lastDataAt` is bumped on every chunk in spawnAgentTerminal).
const TUI_QUIET_MS = 400;
const TUI_QUIET_CAP_MS = 5_000;
async function waitTuiQuiescent(session: AgentTerminalSession, signal: AbortSignal): Promise<void> {
  const start = Date.now();
  while (!signal.aborted) {
    if (Date.now() - session.lastDataAt >= TUI_QUIET_MS) return;
    if (Date.now() - start >= TUI_QUIET_CAP_MS) return; // proceed anyway at the cap
    await sleep(80);
  }
}

export type DispatchResult = { ok: true; reply: string } | { ok: false; error: string };

/**
 * Drive a worker session's terminal with an orchestrator prompt and return its
 * reply. Serialized per worker (withDispatchLock). If the worker terminal isn't
 * up yet, it's cold-started with the prompt SEEDED via the positional arg
 * (auto-runs — injecting into a fresh TUI is unreliable). If it's already up, the
 * human is locked out, any in-flight human turn is waited out, then the prompt is
 * injected. The reply is the Stop-hook payload's last_assistant_message.
 */
export function dispatchToWorker(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<DispatchResult> {
  return withDispatchLock(sessionId, async () => {
    // Paint the canvas edge yellow for the duration of the dispatched turn —
    // terminal workers bypass the runner, so isAiRunning never sees them.
    emitWorkerStatusIfMember(sessionId, true);
    try {
      const existing = sessions.get(sessionId);
      if (!existing) {
        // Cold start: arm the Stop waiter, then spawn with the seeded prompt. No
        // human can be mid-turn (the terminal didn't exist). Lock + mark in-flight
        // so a human attaching mid-seed can't interleave.
        const stop = awaitNextStop(sessionId, signal, timeoutMs);
        const spawned = await spawnAgentTerminal(sessionId, 120, 40, text);
        if ('reason' in spawned) return { ok: false, error: spawned.reason };
        setLock(spawned, sessionId, 'dispatch');
        beginTurn(spawned, sessionId);
        try {
          const payload = await stop;
          return { ok: true, reply: payload.lastAssistantMessage ?? '' };
        } finally {
          if (sessions.get(sessionId) === spawned) setLock(spawned, sessionId, null);
        }
      }
      // Settled worker: lock out new human keystrokes, wait for any in-flight
      // human turn to finish, THEN arm + inject so the next Stop is ours.
      setLock(existing, sessionId, 'dispatch');
      try {
        const idle = await waitTurnIdle(existing, signal, timeoutMs);
        if (!idle) return { ok: false, error: 'worker busy: prior turn did not finish in time' };
        // Let the TUI settle (redraw its input box) before injecting, or the
        // keystrokes are dropped and the prompt never submits.
        await waitTuiQuiescent(existing, signal);
        const stop = awaitNextStop(sessionId, signal, timeoutMs);
        beginTurn(existing, sessionId);
        await submitToTui(existing.pty, text);
        const payload = await stop;
        return { ok: true, reply: payload.lastAssistantMessage ?? '' };
      } finally {
        if (sessions.get(sessionId) === existing) setLock(existing, sessionId, null);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      emitWorkerStatusIfMember(sessionId, false);
    }
  });
}
