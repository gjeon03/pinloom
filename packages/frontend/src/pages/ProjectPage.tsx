import { useEffect, useState } from 'react';
import type { Message, Project, Session } from '@planloom/shared';
import { api } from '../api/client.js';
import { SessionTabs } from '../components/SessionTabs.js';
import { ChatView } from '../components/ChatView.js';
import { PinnedPanel } from '../components/PinnedPanel.js';
import { LogsDrawer } from '../components/LogsDrawer.js';

export function ProjectPage({ project }: { project: Project }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [pins, setPins] = useState<Message[]>([]);

  useEffect(() => {
    let cancelled = false;
    setSessions([]);
    setActiveSession(null);
    setPins([]);

    api.listSessions(project.id).then(async (list) => {
      if (cancelled) return;
      if (list.length > 0) {
        setSessions(list);
        setActiveSession(list[0]);
      } else {
        const created = await api.createSession(project.id, { title: 'New chat' });
        if (cancelled) return;
        setSessions([created]);
        setActiveSession(created);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [project.id]);

  useEffect(() => {
    if (!activeSession) {
      setPins([]);
      return;
    }
    api.listPins(activeSession.id).then(setPins);
  }, [activeSession?.id]);

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

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-3">
        <div>
          <div className="text-sm font-semibold">{project.name}</div>
          <div className="text-[10px] text-[var(--color-ink-muted)] font-mono">
            {project.cwd}
          </div>
        </div>
      </header>

      <SessionTabs
        projectId={project.id}
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        onSelect={setActiveSession}
        onCreate={(s) => {
          setSessions((prev) => [s, ...prev]);
          setActiveSession(s);
        }}
        onDelete={(id) => {
          setSessions((prev) => {
            const next = prev.filter((s) => s.id !== id);
            if (activeSession?.id === id) setActiveSession(next[0] ?? null);
            return next;
          });
        }}
        onRename={(updated) => {
          setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          if (activeSession?.id === updated.id) setActiveSession(updated);
        }}
      />

      <div className="flex-1 flex min-h-0">
        {pins.length > 0 && (
          <PinnedPanel
            pins={pins}
            onChange={handlePinsChange}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeSession ? (
            <ChatView session={activeSession} onPinChange={handlePinsChange} />
          ) : (
            <div className="p-6 text-sm text-[var(--color-ink-muted)]">
              No sessions yet. Click + in the tab bar to create one.
            </div>
          )}
        </div>
      </div>

      {activeSession && <LogsDrawer session={activeSession} />}
    </div>
  );
}
