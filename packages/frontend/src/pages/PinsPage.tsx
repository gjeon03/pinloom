import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { PinnedPanel } from '../components/PinnedPanel.js';

export function PinsPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [pins, setPins] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    Promise.all([
      api.listPins(sessionId),
      api.listProjects().then(async (projects) => {
        for (const p of projects) {
          const list = await api.listSessions(p.id);
          const found = list.find((s) => s.id === sessionId);
          if (found) return found;
        }
        return null;
      }),
    ])
      .then(([pinList, sess]) => {
        if (cancelled) return;
        setPins(pinList);
        setSession(sess);
      })
      .catch((e) => !cancelled && setError(String(e)));

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useWebSocket(sessionId ? `session:${sessionId}` : null, (ev) => {
    if (!sessionId) return;
    if (ev.type === 'message_updated' && ev.sessionId === sessionId) {
      setPins((prev) => {
        const exists = prev.some((p) => p.id === ev.message.id);
        if (ev.message.pinned) {
          return exists
            ? prev.map((p) => (p.id === ev.message.id ? ev.message : p))
            : [...prev, ev.message];
        }
        return prev.filter((p) => p.id !== ev.message.id);
      });
    } else if (ev.type === 'message' && ev.sessionId === sessionId) {
      if (ev.message.pinned) {
        setPins((prev) =>
          prev.some((p) => p.id === ev.message.id) ? prev : [...prev, ev.message],
        );
      }
    }
  });

  function handlePinsChange(updated: Message) {
    setPins((prev) => {
      const exists = prev.some((p) => p.id === updated.id);
      if (updated.pinned) {
        return exists
          ? prev.map((p) => (p.id === updated.id ? updated : p))
          : [...prev, updated];
      }
      return prev.filter((p) => p.id !== updated.id);
    });
  }

  if (!sessionId) {
    return (
      <div className="p-6 text-sm text-[var(--color-ink-muted)]">
        No session id.
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-sm text-red-400">{error}</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            Pins
          </div>
          <div className="text-sm font-semibold">
            {session?.title ?? `Chat ${sessionId.slice(0, 6)}`}
          </div>
        </div>
        <div className="text-xs text-[var(--color-ink-muted)]">
          {pins.length} pin{pins.length === 1 ? '' : 's'}
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <PinnedPanel
          pins={pins}
          onChange={handlePinsChange}
          sessionId={sessionId}
          showPopOut={false}
        />
      </div>
    </div>
  );
}
