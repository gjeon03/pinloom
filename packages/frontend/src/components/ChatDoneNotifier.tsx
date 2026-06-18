import { useEffect, useRef } from 'react';
import { WS_RUNS_CHANNEL } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { useNotifications } from '../stores/notifications.js';
import { isSessionVisible } from '../stores/activeSession.js';
import { setSessionRunning } from '../stores/sessionRunning.js';

// Debounce a finish before raising the notification: when the user has
// queued several messages, a turn boundary emits `finished` and then the next
// turn's `started` arrives right after. Waiting briefly and cancelling on a
// follow-up `started` means we only notify when the session is genuinely idle.
const SETTLE_MS = 1200;

// App-wide listener on the global runs channel. When any session's agent turn
// ends (and that session isn't the one you're actively looking at), raise a
// top-right notification whose click jumps to the session's tab.
// Stable id for a session's "in progress" entry, so multi-turn runs reuse one
// row and the finish can dismiss exactly it. Exported so the session-delete
// path can dismiss it too — a delete swallows the terminal run_activity, so
// this row would otherwise be stranded in "In progress".
export const runningNotifId = (sessionId: string) => `chat-run:${sessionId}`;

export function ChatDoneNotifier() {
  const { notify, start, dismiss } = useNotifications();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useWebSocket(WS_RUNS_CHANNEL, (ev) => {
    if (ev.type !== 'run_activity') return;
    const { sessionId, projectId, title, agent, phase } = ev;
    const pending = timers.current;
    const label = title ?? `Chat ${sessionId.slice(0, 6)}`;
    const agentName = agent === 'codex' ? 'Codex' : 'Claude';

    if (phase === 'started') {
      // Light up the session's tab as "working now".
      setSessionRunning(sessionId, true);
      // Surface it in the bell's "In progress" section so a run you've
      // navigated away from is findable + one click away. Skip the session
      // you're already looking at (no point listing it). start() is
      // idempotent on the id, so successive turns reuse the one row.
      if (!isSessionVisible(sessionId)) {
        start({
          id: runningNotifId(sessionId),
          kind: 'chat-done',
          title: `${label} — ${agentName} is working…`,
          meta: { sessionId, projectId, sessionTitle: title },
        });
      }
      const t = pending.get(sessionId);
      if (t) {
        clearTimeout(t);
        pending.delete(sessionId);
      }
      return;
    }

    // phase === 'finished' | 'error' — turn ended, clear the tab dot.
    setSessionRunning(sessionId, false);
    const existing = pending.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      // Idle now — drop the "in progress" entry (no-op if none was created).
      dismiss(runningNotifId(sessionId));
      // Skip the done toast for a chat that's on screen in ANY dock pane
      // (focused or a side-by-side split); if the window is hidden/blurred,
      // notify anyway (you're not watching it).
      if (
        isSessionVisible(sessionId) &&
        document.visibilityState === 'visible'
      ) {
        return;
      }
      notify({
        kind: 'chat-done',
        status: phase === 'error' ? 'error' : 'success',
        title:
          phase === 'error'
            ? `${label} — ${agentName} stopped`
            : `${label} — ${agentName} is waiting for you`,
        meta: { sessionId, projectId, sessionTitle: title },
      });
    }, SETTLE_MS);
    pending.set(sessionId, timer);
  });

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return null;
}
