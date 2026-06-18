// Which sessions are currently running an agent turn — fed globally by the
// `run_activity` events on WS_RUNS_CHANNEL (every session's started/finished
// across ALL projects, not just the focused one). This is the single source of
// truth for both the per-tab running dot AND the notification bell's
// "In progress" tab, so a long task in another project is findable + one click
// away regardless of whether its tab is on screen.
//
// Reactive (useSyncExternalStore) — tab headers and the bell must re-render
// when running state changes.
//
// Scope note: run_activity is emitted by the SDK runner AND (since the terminal
// started-signal change) by terminal turns, so both SDK and terminal sessions
// light up.

import { useSyncExternalStore } from 'react';

export interface RunningSession {
  sessionId: string;
  projectId: string;
  title: string | null;
  agent: 'claude' | 'codex';
  startedAt: number;
}

const running = new Map<string, RunningSession>();
const listeners = new Set<() => void>();

// Cached array snapshot so useRunningSessions returns a stable reference between
// changes (useSyncExternalStore requires getSnapshot to be referentially stable
// when nothing changed, or it loops). Rebuilt only on mutation.
let snapshot: RunningSession[] = [];
function rebuild(): void {
  snapshot = [...running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function emit(): void {
  for (const l of listeners) l();
}

export function setSessionRunning(
  sessionId: string,
  info: Omit<RunningSession, 'sessionId' | 'startedAt'> | null,
  startedAt?: number,
): void {
  if (info) {
    if (running.has(sessionId)) return; // already running — keep the first startedAt
    running.set(sessionId, {
      sessionId,
      startedAt: startedAt ?? running.get(sessionId)?.startedAt ?? Date.now(),
      ...info,
    });
  } else {
    if (!running.has(sessionId)) return;
    running.delete(sessionId);
  }
  rebuild();
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe to a single session's running state — for the tab dot. */
export function useSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => running.has(sessionId));
}

/** All currently-running sessions (across every project), oldest first — for
 *  the notification bell's "In progress" tab. */
export function useRunningSessions(): RunningSession[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
