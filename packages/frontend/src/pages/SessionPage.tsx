import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';
import type { Message, Project, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ChatView } from '../components/ChatView.js';
import { PinnedPanel } from '../components/PinnedPanel.js';
import { BottomPanel } from '../components/BottomPanel.js';
import { HSplitter } from '../components/HSplitter.js';
import { applyPinChange } from '../utils/pins.js';

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
        const { session: found, project: p } =
          await api.getSessionContext(sessionId);
        if (cancelled) return;
        setProject(p);
        setSession(found);
        document.title = found.title ?? 'pinloom session';
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Pins via SWR — same cache as ProjectPage so the standalone session
  // window inherits any pins already loaded in the main app, and a focus
  // revalidate keeps both views in sync.
  const { data: pinsData } = useSWR(
    sessionId ? cacheKeys.sessionPins(sessionId) : null,
    sessionId ? () => api.listPins(sessionId) : null,
  );
  useEffect(() => {
    if (pinsData) setPins(pinsData);
  }, [pinsData]);

  useWebSocket(sessionId ? `session:${sessionId}` : null, (ev) => {
    if (!sessionId) return;
    if (ev.type === 'message_updated' && ev.sessionId === sessionId) {
      setPins((prev) => applyPinChange(prev, ev.message));
    } else if (ev.type === 'message' && ev.sessionId === sessionId) {
      if (ev.message.pinned) {
        setPins((prev) => applyPinChange(prev, ev.message));
      }
    }
  });

  function handlePinsChange(updated: Message) {
    setPins((prev) => applyPinChange(prev, updated));
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
                projectName={project.name}
                showPopOut={false}
              />
            ) : null
          }
          right={
            <ChatView
              key={session.id}
              session={session}
              onPinChange={handlePinsChange}
              onSessionUpdate={setSession}
            />
          }
        />
      </div>

      <BottomPanel projectId={project.id} session={session} />
    </div>
  );
}
