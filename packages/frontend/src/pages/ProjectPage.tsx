import { useEffect, useState } from 'react';
import type { Message, Project, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import {
  SessionTabs,
  type InlineCanvasTab,
} from '../components/SessionTabs.js';
import { ChatView } from '../components/ChatView.js';
import { PinnedPanel } from '../components/PinnedPanel.js';
import { BottomPanel } from '../components/BottomPanel.js';
import { HSplitter } from '../components/HSplitter.js';
import { EditableTitle } from '../components/EditableTitle.js';
import { SessionPickerModal } from '../components/SessionPickerModal.js';
import { TeamCanvasPage } from './TeamCanvasPage.js';
import { applyPinChange } from '../utils/pins.js';

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
  // Inline canvas tabs the user opened next to chats. Reset when the
  // project changes (each project has its own strip). The active view
  // is either a session OR a canvas tab — we track which so the right
  // panel renders accordingly.
  const [canvasTabs, setCanvasTabs] = useState<InlineCanvasTab[]>([]);
  const [activeCanvasTeamId, setActiveCanvasTeamId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setSessions([]);
    setActiveSession(null);
    setPins([]);
    setCanvasTabs([]);
    setActiveCanvasTeamId(null);

    const lastKey = `pinloom:lastSession:${project.id}`;
    const lastId = localStorage.getItem(lastKey);

    api.listSessions(project.id).then(async (list) => {
      if (cancelled) return;
      if (list.length > 0) {
        setSessions(list);
        const remembered = lastId ? list.find((s) => s.id === lastId) : null;
        setActiveSession(remembered ?? list[0]);
      } else {
        const created = await api.createSession(project.id, { title: null });
        if (cancelled) return;
        setSessions([created]);
        setActiveSession(created);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Remember last active session per project
  useEffect(() => {
    if (!activeSession) return;
    localStorage.setItem(
      `pinloom:lastSession:${project.id}`,
      activeSession.id,
    );
  }, [project.id, activeSession?.id]);

  useEffect(() => {
    if (!activeSession) {
      setPins([]);
      return;
    }
    api.listPins(activeSession.id).then(setPins);
  }, [activeSession?.id]);

  function handlePinsChange(updated: Message) {
    setPins((prev) => applyPinChange(prev, updated));
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
        activeSessionId={
          activeCanvasTeamId === null ? activeSession?.id ?? null : null
        }
        onSelect={(s) => {
          setActiveCanvasTeamId(null);
          setActiveSession(s);
        }}
        onCreate={(s) => {
          setSessions((prev) => [...prev, s]);
          setActiveCanvasTeamId(null);
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
        canvasTabs={canvasTabs}
        activeCanvasTeamId={activeCanvasTeamId}
        onSelectCanvas={(teamId) => setActiveCanvasTeamId(teamId)}
        onCloseCanvas={(teamId) => {
          setCanvasTabs((prev) => prev.filter((c) => c.teamId !== teamId));
          if (activeCanvasTeamId === teamId) setActiveCanvasTeamId(null);
        }}
        onOpenCanvasTab={(tab) => {
          setCanvasTabs((prev) =>
            prev.some((c) => c.teamId === tab.teamId) ? prev : [...prev, tab],
          );
          setActiveCanvasTeamId(tab.teamId);
        }}
      />

      <div className="flex-1 flex min-h-0">
        <HSplitter
          storageKey={`pinloom:splitter:${project.id}`}
          minLeft={320}
          minRight={420}
          left={
            pins.length > 0 && activeSession ? (
              <PinnedPanel
                key={activeSession.id}
                pins={pins}
                onChange={handlePinsChange}
                sessionId={activeSession.id}
                projectName={project.name}
                onHandoff={(newSession) => {
                  setSessions((prev) => [...prev, newSession]);
                  setActiveSession(newSession);
                }}
                onSendPin={(pin) => setSendingPin(pin)}
              />
            ) : null
          }
          right={
            activeCanvasTeamId ? (
              // Inline canvas — wraps the dedicated route's component so
              // updates / fixes flow into both surfaces. The page reads
              // teamId from the URL via useParams, so we route inline by
              // overriding the `teamId` segment via a key + path.
              <InlineCanvasView teamId={activeCanvasTeamId} />
            ) : activeSession ? (
              // Force a fresh component instance per session so per-session
              // local state (textarea draft, queue, wikiSyncing flag, etc.)
              // doesn't leak across tab switches.
              <ChatView
                key={activeSession.id}
                session={activeSession}
                onPinChange={handlePinsChange}
              />
            ) : (
              <div className="p-6 text-sm text-[var(--color-ink-muted)]">
                No sessions yet. Click + in the tab bar to create one.
              </div>
            )
          }
        />
      </div>

      {activeSession && (
        <BottomPanel
          key={activeSession.id}
          projectId={project.id}
          session={activeSession}
        />
      )}

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

// Thin wrapper around TeamCanvasPage for inline mounting in the right
// pane. The header is suppressed because the SessionTabs strip already
// shows which canvas is active. `key={teamId}` resets internal state on
// switch so events from a previous team don't bleed in.
function InlineCanvasView({ teamId }: { teamId: string }) {
  return <TeamCanvasPage key={teamId} teamId={teamId} showHeader={false} />;
}
