import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Message, Project, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ChatView } from '../components/ChatView.js';
import { PinnedPanel } from '../components/PinnedPanel.js';
import { BottomPanel } from '../components/BottomPanel.js';
import { HSplitter } from '../components/HSplitter.js';

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [pins, setPins] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    (async () => {
      try {
        const projects = await api.listProjects();
        for (const p of projects) {
          const list = await api.listSessions(p.id);
          const found = list.find((s) => s.id === sessionId);
          if (found) {
            if (cancelled) return;
            setProject(p);
            setSession(found);
            const pinList = await api.listPins(sessionId);
            if (!cancelled) setPins(pinList);
            document.title = found.title ?? 'pinloom session';
            return;
          }
        }
        if (!cancelled) setError('session not found');
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

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

  const splitterKey = useMemo(
    () => (project ? `pinloom:splitter:${project.id}` : undefined),
    [project],
  );

  if (error) {
    return <div className="p-6 text-sm text-red-400">{error}</div>;
  }
  if (!session || !project) {
    return <div className="p-6 text-sm text-[var(--color-ink-muted)]">Loading session…</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-4 py-2">
        <div className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
          {project.name}
        </div>
        <div className="text-sm font-semibold truncate">
          {session.title ?? `Chat ${session.id.slice(0, 6)}`}
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <HSplitter
          storageKey={splitterKey}
          minLeft={320}
          minRight={420}
          left={
            pins.length > 0 ? (
              <PinnedPanel
                pins={pins}
                onChange={handlePinsChange}
                sessionId={session.id}
                showPopOut={false}
              />
            ) : null
          }
          right={<ChatView session={session} onPinChange={handlePinsChange} />}
        />
      </div>

      <BottomPanel projectId={project.id} session={session} />
    </div>
  );
}
