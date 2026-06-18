// Which sessions are currently running an agent turn — fed globally by the
// `run_activity` events on WS_RUNS_CHANNEL (every session's started/finished,
// not just the focused one). Lets any session tab show a "working now" dot so
// a long task you've navigated away from is easy to find again.
//
// Reactive (useSyncExternalStore) — unlike activeSession.ts's imperative state —
// because tab headers must re-render when a session's running state flips.
//
// Scope note: run_activity is emitted by the SDK runner (emitRunStatus). A live
// terminal-mode TUI doesn't route through it, so terminal sessions don't light
// up here; that's a deliberate P1 boundary (a PTY has no clean turn boundary).

import { useSyncExternalStore } from 'react';

const runningIds = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setSessionRunning(sessionId: string, running: boolean): void {
  const had = runningIds.has(sessionId);
  if (running === had) return;
  if (running) runningIds.add(sessionId);
  else runningIds.delete(sessionId);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe to a single session's running state — re-renders only when THIS
 *  session flips. getSnapshot returns a stable boolean, so no extra renders. */
export function useSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => runningIds.has(sessionId),
  );
}
