import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';
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
import { useT } from '../i18n/t.js';

export function SessionPage() {
  const t = useT();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  // In the installed PWA there is no browser back button, so a session/bot page
  // opened standalone is a dead end without this. Go back if there's history,
  // else fall back to the session's project (or home).
  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate(project ? `/projects/${project.id}` : '/');
  }
  // Bot sessions are singletons (reused), so a new request inherits the prior
  // one's context — let the user reset to a clean slate.
  async function resetBotSession() {
    if (!session?.botKind) return;
    if (!window.confirm(t('page.session.resetConfirm'))) return;
    try {
      await api.resetBot(session.botKind);
      sessionStorage.removeItem(`pinloom:input:${session.id}`);
      window.location.reload();
    } catch {
      /* ignore — leave the session as-is */
    }
  }
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
        document.title = found.title ?? t('page.session.docTitle');
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
    return <div className="p-6 text-sm text-[var(--color-ink-muted)]">{t('page.session.loading')}</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-surface)]">
      <header className="titlebar-trafficlights border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          title={t('page.session.back')}
          aria-label={t('page.session.back')}
          className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            {project.name}
          </div>
          <div className="text-sm font-semibold truncate">
            {session.title ?? t('page.session.chatFallback', { id: session.id.slice(0, 6) })}
          </div>
        </div>
        {session.botKind && (
          <button
            type="button"
            onClick={resetBotSession}
            title={t('page.session.reset')}
            className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
          >
            <RotateCcw size={14} />
            {t('page.session.reset')}
          </button>
        )}
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
