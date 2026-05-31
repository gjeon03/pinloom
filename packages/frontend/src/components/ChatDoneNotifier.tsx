import { useEffect, useRef } from 'react';
import { WS_RUNS_CHANNEL } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { useNotifications } from '../stores/notifications.js';
import { getActiveSessionId } from '../stores/activeSession.js';

// Debounce a finish before raising the notification: when the user has
// queued several messages, a turn boundary emits `finished` and then the next
// turn's `started` arrives right after. Waiting briefly and cancelling on a
// follow-up `started` means we only notify when the session is genuinely idle.
const SETTLE_MS = 1200;

// App-wide listener on the global runs channel. When any session's agent turn
// ends (and that session isn't the one you're actively looking at), raise a
// top-right notification whose click jumps to the session's tab.
export function ChatDoneNotifier() {
  const { notify } = useNotifications();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useWebSocket(WS_RUNS_CHANNEL, (ev) => {
    if (ev.type !== 'run_activity') return;
    const { sessionId, projectId, title, agent, phase } = ev;
    const pending = timers.current;

    if (phase === 'started') {
      const t = pending.get(sessionId);
      if (t) {
        clearTimeout(t);
        pending.delete(sessionId);
      }
      return;
    }

    // phase === 'finished' | 'error'
    const existing = pending.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      // Skip the chat you're already watching in the foreground; if the
      // window is hidden/blurred, notify anyway (you're not watching it).
      if (
        getActiveSessionId() === sessionId &&
        document.visibilityState === 'visible'
      ) {
        return;
      }
      const label = title ?? `Chat ${sessionId.slice(0, 6)}`;
      const agentName = agent === 'codex' ? 'Codex' : 'Claude';
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
