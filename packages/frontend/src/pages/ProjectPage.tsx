import { useEffect, useState } from 'react';
import type { Message, Project, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { SessionTabs } from '../components/SessionTabs.js';
import { ChatView } from '../components/ChatView.js';
import { PinnedPanel } from '../components/PinnedPanel.js';
import { LogsDrawer } from '../components/LogsDrawer.js';
import { HSplitter } from '../components/HSplitter.js';
import { EditableTitle } from '../components/EditableTitle.js';
import { SessionPickerModal } from '../components/SessionPickerModal.js';

export function ProjectPage({
  project,
  onRenamed,
}: {
  project: Project;
  onRenamed?: (project: Project) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [pins, setPins] = useState<Message[]>([]);
  const [sendingPin, setSendingPin] = useState<Message | null>(null);

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
          <EditableTitle
            value={project.name}
            onSave={async (next) => {
              const updated = await api.renameProject(project.id, next);
              onRenamed?.(updated);
            }}
            className="text-sm font-semibold"
          />
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
          setSessions((prev) => [...prev, s]);
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
        onReorder={(reordered) => setSessions(reordered)}
      />

      <div className="flex-1 flex min-h-0">
        <HSplitter
          storageKey={`pinloom:splitter:${project.id}`}
          minLeft={320}
          minRight={420}
          left={
            pins.length > 0 && activeSession ? (
              <PinnedPanel
                pins={pins}
                onChange={handlePinsChange}
                sessionId={activeSession.id}
                onHandoff={(newSession) => {
                  setSessions((prev) => [...prev, newSession]);
                  setActiveSession(newSession);
                }}
                onSendPin={(pin) => setSendingPin(pin)}
              />
            ) : null
          }
          right={
            activeSession ? (
              <ChatView session={activeSession} onPinChange={handlePinsChange} />
            ) : (
              <div className="p-6 text-sm text-[var(--color-ink-muted)]">
                No sessions yet. Click + in the tab bar to create one.
              </div>
            )
          }
        />
      </div>

      {activeSession && <LogsDrawer session={activeSession} />}

      {sendingPin && activeSession && (
        <SessionPickerModal
          pin={sendingPin}
          projectId={project.id}
          sessions={sessions}
          currentSessionId={activeSession.id}
          onClose={() => setSendingPin(null)}
          onNewSessionCreated={(s) => setSessions((prev) => [...prev, s])}
        />
      )}
    </div>
  );
}
