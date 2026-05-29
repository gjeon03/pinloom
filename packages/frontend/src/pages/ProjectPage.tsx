import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { Message, Project, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import {
  SessionTabs,
  type InlineCanvasTab,
  type TabRef,
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
  // Inline canvas tabs the user opened next to chats. Persisted per
  // project in localStorage so they survive cross-project navigation.
  // The active view is either a session OR a canvas tab — we track
  // which so the right panel renders accordingly.
  const [canvasTabs, setCanvasTabs] = useState<InlineCanvasTab[]>([]);
  const [activeCanvasTeamId, setActiveCanvasTeamId] = useState<string | null>(
    null,
  );
  // Unified ordering of session + canvas tabs as the user has arranged
  // them. The two underlying arrays (sessions / canvasTabs) keep their
  // own shapes for everything else (data fetching, persistence); this
  // array only governs the strip order.
  const [tabOrder, setTabOrder] = useState<TabRef[]>([]);

  function persistCanvasTabs(projectId: string, tabs: InlineCanvasTab[]) {
    try {
      localStorage.setItem(
        `pinloom:canvasTabs:${projectId}`,
        JSON.stringify(tabs),
      );
    } catch {
      // localStorage may be unavailable (private mode, quota); the
      // tabs still work for this session, just won't survive reload.
    }
  }

  function persistTabOrder(projectId: string, order: TabRef[]) {
    try {
      localStorage.setItem(
        `pinloom:tabOrder:${projectId}`,
        JSON.stringify(order),
      );
    } catch {
      // see persistCanvasTabs
    }
  }

  // Reconcile a persisted order against the current set of sessions +
  // canvases: drop refs whose targets no longer exist, append any
  // newcomers at the tail in source-array order. Returns a fresh array
  // so callers can persist it without having to dedupe again.
  function reconcileOrder(
    persisted: TabRef[] | null,
    sessionIds: string[],
    canvasIds: string[],
  ): TabRef[] {
    const sessionSet = new Set(sessionIds);
    const canvasSet = new Set(canvasIds);
    const seen = new Set<string>();
    const out: TabRef[] = [];
    for (const ref of persisted ?? []) {
      if (!ref || typeof ref !== 'object') continue;
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      if (ref.kind === 'session' && sessionSet.has(ref.id)) {
        out.push(ref);
        seen.add(key);
      } else if (ref.kind === 'canvas' && canvasSet.has(ref.id)) {
        out.push(ref);
        seen.add(key);
      }
    }
    for (const id of sessionIds) {
      if (!seen.has(`session:${id}`)) {
        out.push({ kind: 'session', id });
        seen.add(`session:${id}`);
      }
    }
    for (const id of canvasIds) {
      if (!seen.has(`canvas:${id}`)) {
        out.push({ kind: 'canvas', id });
        seen.add(`canvas:${id}`);
      }
    }
    return out;
  }

  // Persist which view (session vs. canvas) was active for this project,
  // so returning to it restores the same tab. Written synchronously from
  // each handler instead of via useEffect to avoid the project-switch
  // race where a stale value would clobber the new project's key.
  function persistActiveCanvas(projectId: string, teamId: string | null) {
    try {
      const key = `pinloom:lastCanvas:${projectId}`;
      if (teamId) localStorage.setItem(key, teamId);
      else localStorage.removeItem(key);
    } catch {
      // see persistCanvasTabs
    }
  }

  useEffect(() => {
    let cancelled = false;
    setSessions([]);
    setActiveSession(null);
    setPins([]);
    // Restore inline canvas tabs for this project. We persist on every
    // mutation rather than via a useEffect — a setter-based approach
    // avoids the race where a project switch's first persist effect
    // overwrites the new project's saved tabs with the previous state.
    let restored: InlineCanvasTab[] = [];
    try {
      const raw = localStorage.getItem(`pinloom:canvasTabs:${project.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Defensive shape check — a tampered or older-schema entry
          // shouldn't poison the strip with undefineds later.
          restored = parsed.filter(
            (t): t is InlineCanvasTab =>
              t &&
              typeof t === 'object' &&
              typeof (t as InlineCanvasTab).teamId === 'string' &&
              typeof (t as InlineCanvasTab).teamName === 'string',
          );
        }
      }
    } catch {
      restored = [];
    }
    setCanvasTabs(restored);
    // Restore which canvas tab was active, but only if it still exists
    // in the persisted strip — otherwise fall back to the chat session.
    const lastCanvasId = localStorage.getItem(
      `pinloom:lastCanvas:${project.id}`,
    );
    const restoreCanvas =
      lastCanvasId && restored.some((t) => t.teamId === lastCanvasId);
    setActiveCanvasTeamId(restoreCanvas ? lastCanvasId : null);

    const lastKey = `pinloom:lastSession:${project.id}`;
    const lastId = localStorage.getItem(lastKey);

    // Read the persisted unified tab order once we know what sessions
    // + canvases actually exist; reconcile against both to drop dead
    // refs and append newcomers in source-array order.
    let persistedOrder: TabRef[] | null = null;
    try {
      const raw = localStorage.getItem(`pinloom:tabOrder:${project.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          persistedOrder = parsed.filter(
            (t): t is TabRef =>
              t &&
              typeof t === 'object' &&
              (t.kind === 'session' || t.kind === 'canvas') &&
              typeof t.id === 'string',
          );
        }
      }
    } catch {
      persistedOrder = null;
    }

    api.listSessions(project.id).then(async (list) => {
      if (cancelled) return;
      if (list.length > 0) {
        setSessions(list);
        const remembered = lastId ? list.find((s) => s.id === lastId) : null;
        setActiveSession(remembered ?? list[0]);
        const order = reconcileOrder(
          persistedOrder,
          list.map((s) => s.id),
          restored.map((c) => c.teamId),
        );
        setTabOrder(order);
        persistTabOrder(project.id, order);
      } else {
        const created = await api.createSession(project.id, { title: null });
        if (cancelled) return;
        setSessions([created]);
        setActiveSession(created);
        const order = reconcileOrder(
          persistedOrder,
          [created.id],
          restored.map((c) => c.teamId),
        );
        setTabOrder(order);
        persistTabOrder(project.id, order);
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

  // Per-session pins via SWR — the cache survives session tab switches
  // so going back to a previously visited session renders pins from memory
  // instead of waiting on a fresh HTTP fetch. WS handles incremental
  // updates; SWR is just the initial seed + focus revalidate safety net.
  const { data: pinsData } = useSWR(
    activeSession ? cacheKeys.sessionPins(activeSession.id) : null,
    activeSession ? () => api.listPins(activeSession.id) : null,
  );
  useEffect(() => {
    if (!activeSession) {
      setPins([]);
      return;
    }
    if (pinsData) setPins(pinsData);
  }, [activeSession?.id, pinsData]);

  // Canvas "go to tab" button. Cross-project navigation is handled by
  // the canvas via navigate() + lastSession seeding; for same-project
  // jumps the route doesn't change, so we listen here and switch the
  // active tab in-place (also clearing any inline canvas tab focus).
  // Read sessions through a ref so the listener doesn't tear down /
  // re-attach on every session-state change — that would otherwise
  // open a window where dispatched events get dropped.
  const sessionsRef = useRef<Session[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    function onGoto(event: Event) {
      const detail = (event as CustomEvent<{
        projectId: string;
        sessionId: string;
      }>).detail;
      if (!detail || detail.projectId !== project.id) return;
      const target = sessionsRef.current.find(
        (s) => s.id === detail.sessionId,
      );
      if (!target) return;
      setActiveCanvasTeamId(null);
      persistActiveCanvas(project.id, null);
      setActiveSession(target);
    }
    window.addEventListener('pinloom:goto-session', onGoto as EventListener);
    return () =>
      window.removeEventListener(
        'pinloom:goto-session',
        onGoto as EventListener,
      );
  }, [project.id]);

  // A session created via an inline modal (e.g. the AddWorker form's
  // "Create new session" button) doesn't pass through this strip's
  // create flow, so the parent doesn't know about it until the page
  // remounts. Listen for the dispatch and splice it in when it lives
  // in the current project. We deliberately do NOT auto-select it —
  // the user is mid-flow on a different tab and a surprise switch
  // would be jarring.
  useEffect(() => {
    function onSessionCreated(event: Event) {
      const detail = (event as CustomEvent<{ session: Session }>).detail;
      const s = detail?.session;
      if (!s || s.projectId !== project.id) return;
      setSessions((prev) =>
        prev.some((p) => p.id === s.id) ? prev : [...prev, s],
      );
    }
    window.addEventListener(
      'pinloom:session-created',
      onSessionCreated as EventListener,
    );
    return () =>
      window.removeEventListener(
        'pinloom:session-created',
        onSessionCreated as EventListener,
      );
  }, [project.id]);

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
          persistActiveCanvas(project.id, null);
          setActiveSession(s);
        }}
        onCreate={(s) => {
          setSessions((prev) => [...prev, s]);
          setTabOrder((prev) => {
            if (prev.some((r) => r.kind === 'session' && r.id === s.id)) {
              return prev;
            }
            const next: TabRef[] = [...prev, { kind: 'session', id: s.id }];
            persistTabOrder(project.id, next);
            return next;
          });
          setActiveCanvasTeamId(null);
          persistActiveCanvas(project.id, null);
          setActiveSession(s);
        }}
        onDelete={(id) => {
          setSessions((prev) => {
            const next = prev.filter((s) => s.id !== id);
            if (activeSession?.id === id) setActiveSession(next[0] ?? null);
            return next;
          });
          setTabOrder((prev) => {
            const next = prev.filter(
              (r) => !(r.kind === 'session' && r.id === id),
            );
            persistTabOrder(project.id, next);
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
        onSelectCanvas={(teamId) => {
          setActiveCanvasTeamId(teamId);
          persistActiveCanvas(project.id, teamId);
        }}
        onCloseCanvas={(teamId) => {
          setCanvasTabs((prev) => {
            const next = prev.filter((c) => c.teamId !== teamId);
            persistCanvasTabs(project.id, next);
            return next;
          });
          setTabOrder((prev) => {
            const next = prev.filter(
              (r) => !(r.kind === 'canvas' && r.id === teamId),
            );
            persistTabOrder(project.id, next);
            return next;
          });
          if (activeCanvasTeamId === teamId) {
            setActiveCanvasTeamId(null);
            persistActiveCanvas(project.id, null);
          }
        }}
        onOpenCanvasTab={(tab) => {
          setCanvasTabs((prev) => {
            const next = prev.some((c) => c.teamId === tab.teamId)
              ? prev
              : [...prev, tab];
            persistCanvasTabs(project.id, next);
            return next;
          });
          setTabOrder((prev) => {
            if (prev.some((r) => r.kind === 'canvas' && r.id === tab.teamId)) {
              return prev;
            }
            const next: TabRef[] = [
              ...prev,
              { kind: 'canvas', id: tab.teamId },
            ];
            persistTabOrder(project.id, next);
            return next;
          });
          setActiveCanvasTeamId(tab.teamId);
          persistActiveCanvas(project.id, tab.teamId);
        }}
        tabOrder={tabOrder}
        onReorderTabs={(nextOrder) => {
          setTabOrder(nextOrder);
          persistTabOrder(project.id, nextOrder);
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
                onSessionUpdate={(updated) => {
                  setSessions((prev) =>
                    prev.map((s) => (s.id === updated.id ? updated : s)),
                  );
                  if (activeSession?.id === updated.id) {
                    setActiveSession(updated);
                  }
                }}
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
          key={project.id}
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
