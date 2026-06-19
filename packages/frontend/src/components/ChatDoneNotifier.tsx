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

// App-wide listener on the global runs channel. It does two things:
//  - maintain the sessionRunning store (drives the tab dot AND the bell's
//    "In progress" tab — a complete, cross-project view of what's running),
//  - on genuine idle, raise a "done" notification you can click to jump back.
export function ChatDoneNotifier() {
  const { notify } = useNotifications();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useWebSocket(WS_RUNS_CHANNEL, (ev) => {
    if (ev.type !== 'run_activity') return;
    const { sessionId, projectId, title, agent, phase } = ev;
    const pending = timers.current;
    const label = title ?? `Chat ${sessionId.slice(0, 6)}`;
    const agentName = agent === 'codex' ? 'Codex' : 'Claude';

    if (phase === 'started') {
      // Record it as running (tab dot + bell In-progress tab). We list EVERY
      // running session, including one you're viewing, so the In-progress tab
      // is a complete picture of what's working across all projects.
      setSessionRunning(sessionId, {
        projectId,
        title,
        agent: agent === 'codex' ? 'codex' : 'claude',
      });
      const t = pending.get(sessionId);
      if (t) {
        clearTimeout(t);
        pending.delete(sessionId);
      }
      return;
    }

    // phase === 'finished' | 'error' — turn ended, clear running.
    setSessionRunning(sessionId, null);
    const existing = pending.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(sessionId);
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
