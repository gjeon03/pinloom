// Project workspace: a dockview-managed main area (each tab = a panel; tabs
// can be dragged into VSCode-style splits) plus the fixed chrome around it
// (header, left pins rail, bottom panel). The dock layout persists per
// project as DockviewApi.toJSON() under `pinloom:layout:<projectId>`; legacy
// pre-dock keys (tabOrder / last*) are read once as a migration source.

import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import type {
  AgentKind,
  Message,
  Project,
  ProjectNotepadSummary,
  Session,
} from '@pinloom/shared';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import { api, projectNotepadApi } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { cacheKeys } from '../api/cacheKeys.js';
import {
  setActiveSessionId,
  setVisibleSessionIds,
} from '../stores/activeSession.js';
import { setSessionRunning } from '../stores/sessionRunning.js';
import { runningNotifId } from '../components/ChatDoneNotifier.js';
import { useNotifications } from '../stores/notifications.js';
import { BottomPanel } from '../components/BottomPanel.js';
import { EditableTitle } from '../components/EditableTitle.js';
import { SessionPickerModal } from '../components/SessionPickerModal.js';
import { applyPinChange } from '../utils/pins.js';
import { buildTeamRoles } from '../components/tabs/teamRoles.js';
import {
  DockProvider,
  type DockContextValue,
  type TabMenuRequest,
} from '../components/dock/DockContext.js';
import {
  ChatPanel,
  TerminalPanel,
  CanvasPanel,
  NotepadPanel,
  DockWatermark,
} from '../components/dock/panels.js';
import { ProjectTab } from '../components/dock/ProjectTab.js';
import { GroupActions } from '../components/dock/GroupActions.js';
import { TabMenuHost } from '../components/dock/TabMenuHost.js';
import {
  loadLayout,
  saveLayout,
  loadLegacyState,
  reconcileOrder,
  reconcileLayout,
  panelId,
  parsePanelId,
  type InlineCanvasTab,
  type TabRef,
} from '../components/dock/layout.js';

// A session that renders as a live terminal (claude OR codex) instead of the
// structured ChatView. Structured sessions (transport !== 'terminal') of
// either agent still use ChatView.
function isTerminalAgentSession(s: Session): boolean {
  return (
    s.transport === 'terminal' && (s.agent === 'claude' || s.agent === 'codex')
  );
}

// Stable component maps for DockviewReact — defined at module level so the
// dock doesn't re-register components on every render.
const DOCK_COMPONENTS = {
  chat: ChatPanel,
  terminal: TerminalPanel,
  canvas: CanvasPanel,
  notepad: NotepadPanel,
};

export function ProjectPage({
  project,
  onRenamed,
}: {
  project: Project;
  onRenamed?: (project: Project) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [canvasTabs, setCanvasTabs] = useState<InlineCanvasTab[]>([]);
  const [notepads, setNotepads] = useState<ProjectNotepadSummary[]>([]);
  // Which panel currently holds dock focus — the single source for the
  // "active view" everything downstream reads (pins rail, bottom panel,
  // notification suppression). Derived from onDidActivePanelChange.
  const [focused, setFocused] = useState<TabRef | null>(null);
  // Every session visible across the dock's groups (each group's selected
  // tab). With splits, more than one session can be on screen at once —
  // all of them count as "being watched" for notifications/read-state.
  const [visibleSet, setVisibleSet] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [sendingPin, setSendingPin] = useState<{
    pin: Message;
    sessionId: string;
  } | null>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuRequest | null>(null);
  const [stripError, setStripError] = useState<string | null>(null);
  const [codexAvailable, setCodexAvailable] = useState<boolean | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const { markSessionRead, dismiss: dismissNotification } = useNotifications();

  const dockRef = useRef<DockviewApi | null>(null);
  const builtRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRef = useRef<Session[]>(sessions);
  const canvasesRef = useRef<InlineCanvasTab[]>(canvasTabs);
  const notepadsRef = useRef<ProjectNotepadSummary[]>(notepads);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    canvasesRef.current = canvasTabs;
  }, [canvasTabs]);
  useEffect(() => {
    notepadsRef.current = notepads;
  }, [notepads]);

  const activeSession = useMemo(
    () =>
      focused?.kind === 'session'
        ? sessions.find((s) => s.id === focused.id) ?? null
        : null,
    [focused, sessions],
  );

  // Team membership for tab badges (shared SWR key, centrally revalidated
  // by App.tsx on `pinloom:teams-changed`).
  const { data: teams = [] } = useSWR(cacheKeys.teams(), () => api.listTeams());
  const rolesBySessionId = useMemo(() => buildTeamRoles(teams), [teams]);

  // One-shot health probe to know whether the Codex CLI is on PATH. Only
  // dims the '+' picker option — the backend reports a clear spawn error
  // if the user tries anyway.
  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setCodexAvailable(h.agents?.codex?.installed ?? false);
      })
      .catch(() => {
        if (!cancelled) setCodexAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function persistCanvasTabs(projectId: string, tabs: InlineCanvasTab[]) {
    try {
      localStorage.setItem(
        `pinloom:canvasTabs:${projectId}`,
        JSON.stringify(tabs),
      );
    } catch {
      // localStorage may be unavailable (private mode, quota); the tabs
      // still work for this session, just won't survive reload.
    }
  }

  // ─── dock panel helpers ───

  // A captured groupId can go stale before an (async) addPanel runs — e.g.
  // the group collapsed when its last panel was removed, or closed during an
  // awaited session create. dockview THROWS on an unknown referenceGroup, so
  // validate and fall back to "no anchor" (active group) instead.
  function liveGroupId(
    dv: DockviewApi,
    groupId: string | null | undefined,
  ): string | null {
    if (!groupId) return null;
    return dv.groups.some((g) => g.id === groupId) ? groupId : null;
  }

  function addSessionPanel(
    s: Session,
    opts?: { inactive?: boolean; groupId?: string | null },
  ) {
    const dv = dockRef.current;
    if (!dv) return;
    const id = panelId('session', s.id);
    const existing = dv.getPanel(id);
    if (existing) {
      if (!opts?.inactive) existing.api.setActive();
      return;
    }
    dv.addPanel({
      id,
      // Component chosen at add time: a session's transport is pinned at
      // creation, so this never goes stale.
      component: isTerminalAgentSession(s) ? 'terminal' : 'chat',
      params: { kind: 'session', sessionId: s.id },
      inactive: opts?.inactive ?? false,
      ...(liveGroupId(dv, opts?.groupId)
        ? { position: { referenceGroup: liveGroupId(dv, opts?.groupId)! } }
        : {}),
    });
  }

  function addCanvasPanel(
    teamId: string,
    opts?: { inactive?: boolean; groupId?: string | null },
  ) {
    const dv = dockRef.current;
    if (!dv) return;
    const id = panelId('canvas', teamId);
    const existing = dv.getPanel(id);
    if (existing) {
      if (!opts?.inactive) existing.api.setActive();
      return;
    }
    dv.addPanel({
      id,
      component: 'canvas',
      params: { kind: 'canvas', teamId },
      inactive: opts?.inactive ?? false,
      ...(liveGroupId(dv, opts?.groupId)
        ? { position: { referenceGroup: liveGroupId(dv, opts?.groupId)! } }
        : {}),
    });
  }

  function addNotepadPanel(
    notepadId: string,
    opts?: { inactive?: boolean; groupId?: string | null },
  ) {
    const dv = dockRef.current;
    if (!dv) return;
    const id = panelId('notepad', notepadId);
    const existing = dv.getPanel(id);
    if (existing) {
      if (!opts?.inactive) existing.api.setActive();
      return;
    }
    dv.addPanel({
      id,
      component: 'notepad',
      params: { kind: 'notepad', notepadId },
      inactive: opts?.inactive ?? false,
      ...(liveGroupId(dv, opts?.groupId)
        ? { position: { referenceGroup: liveGroupId(dv, opts?.groupId)! } }
        : {}),
    });
  }

  function addPanelForRef(
    ref: TabRef,
    opts?: { inactive?: boolean; groupId?: string | null },
  ) {
    if (ref.kind === 'session') {
      const s = sessionsRef.current.find((x) => x.id === ref.id);
      if (s) addSessionPanel(s, opts);
    } else if (ref.kind === 'canvas') {
      addCanvasPanel(ref.id, opts);
    } else {
      addNotepadPanel(ref.id, opts);
    }
  }

  function removePanelFor(kind: TabRef['kind'], id: string) {
    const dv = dockRef.current;
    const panel = dv?.getPanel(panelId(kind, id));
    if (dv && panel) dv.removePanel(panel);
  }

  // Best-effort mirror of the visual session order back to local state +
  // the backend, so listSessions' first-load order roughly matches the
  // strip even if localStorage is wiped.
  function syncSessionOrder(dv: DockviewApi) {
    const ids: string[] = [];
    for (const group of dv.groups) {
      for (const p of group.panels) {
        const ref = parsePanelId(p.id);
        if (ref?.kind === 'session') ids.push(ref.id);
      }
    }
    const current = sessionsRef.current;
    if (ids.length !== current.length) return;
    if (current.every((s, i) => s.id === ids[i])) return;
    const byId = new Map(current.map((s) => [s.id, s]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((s): s is Session => s != null);
    if (ordered.length !== current.length) return;
    setSessions(ordered);
    void api.reorderSessions(project.id, ids).catch(() => {
      // best-effort; the dock layout JSON is the real source of truth
    });
  }

  // ─── data load (per project) ───

  useEffect(() => {
    let cancelled = false;
    builtRef.current = false;
    setDataReady(false);
    setSessions([]);
    setNotepads([]);
    setFocused(null);
    setTabMenu(null);
    setSendingPin(null);
    // Restore inline canvas tabs for this project (teamName lives only
    // here — the dock layout references canvases by teamId).
    let restored: InlineCanvasTab[] = [];
    try {
      const raw = localStorage.getItem(`pinloom:canvasTabs:${project.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
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

    Promise.all([
      api.listSessions(project.id),
      projectNotepadApi
        .list(project.id)
        .catch(() => [] as ProjectNotepadSummary[]),
    ]).then(async ([list, npList]) => {
      if (cancelled) return;
      setNotepads(npList);
      if (list.length > 0) {
        setSessions(list);
      } else {
        const created = await api.createSession(project.id, { title: null });
        if (cancelled) return;
        setSessions([created]);
      }
      setDataReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // ─── dock build: restore saved layout or migrate from legacy keys ───

  useEffect(() => {
    const dv = dock;
    if (!dv || !dataReady || builtRef.current) return;
    // Never build against a stale/disposed dock (StrictMode's simulated
    // remount disposes the first instance; dockRef tracks the live one —
    // the effect re-runs when `dock` state catches up).
    if (dockRef.current !== dv) return;

    const sessionIds = sessionsRef.current.map((s) => s.id);
    const canvasIds = canvasesRef.current.map((c) => c.teamId);
    const notepadIds = notepadsRef.current.map((n) => n.id);
    const legacy = loadLegacyState(project.id);

    const saved = loadLayout(project.id);
    let restoredLayout = false;
    if (saved) {
      try {
        dv.fromJSON(saved);
        restoredLayout = true;
      } catch (err) {
        // Corrupt layout — fall through to the migration builder. Never
        // leave the dock blank. Logged because a failing restore silently
        // flattens the user's split arrangement.
        console.warn('[dock] layout restore failed, rebuilding:', err);
        try {
          dv.clear();
        } catch {
          // already empty
        }
      }
    }

    if (restoredLayout) {
      const added = reconcileLayout(
        dv,
        sessionIds,
        canvasIds,
        notepadIds,
        // Anchor to the last existing group so an out-of-band arrival never
        // opens a surprise split (see the migration loop's group anchoring).
        (ref) =>
          addPanelForRef(ref, {
            inactive: true,
            groupId: dv.groups[dv.groups.length - 1]?.id ?? null,
          }),
      );
      // A session moved in from another project pre-seeds lastSession —
      // if its panel was just added by reconcile, surface it.
      if (
        legacy.lastSessionId &&
        added.some(
          (r) => r.kind === 'session' && r.id === legacy.lastSessionId,
        )
      ) {
        dv.getPanel(panelId('session', legacy.lastSessionId))?.api.setActive();
      }
    } else {
      // First dock mount for this project: build panels in the legacy
      // strip order (or default source order) and restore the last
      // active view, so the cutover is invisible.
      const order = reconcileOrder(
        legacy.order,
        sessionIds,
        canvasIds,
        notepadIds,
      );
      // Anchor every panel to the FIRST panel's group: on an empty dock,
      // `addPanel({inactive:true})` with no position leaves no active group,
      // so each subsequent add would otherwise open a group of its own —
      // i.e. one split per tab instead of one strip.
      let migrateGroupId: string | null = null;
      for (const ref of order) {
        addPanelForRef(ref, { inactive: true, groupId: migrateGroupId });
        if (!migrateGroupId) {
          migrateGroupId =
            dv.getPanel(panelId(ref.kind, ref.id))?.group.id ?? null;
        }
      }
      const activate =
        (legacy.lastNotepadId &&
          notepadIds.includes(legacy.lastNotepadId) && {
            kind: 'notepad' as const,
            id: legacy.lastNotepadId,
          }) ||
        (legacy.lastCanvasId &&
          canvasIds.includes(legacy.lastCanvasId) && {
            kind: 'canvas' as const,
            id: legacy.lastCanvasId,
          }) ||
        (legacy.lastSessionId &&
          sessionIds.includes(legacy.lastSessionId) && {
            kind: 'session' as const,
            id: legacy.lastSessionId,
          }) ||
        (order[0] ?? null);
      if (activate) {
        dv.getPanel(panelId(activate.kind, activate.id))?.api.setActive();
      }
    }

    builtRef.current = true;
    // Initial focus + visible-set sync (the change events may have fired
    // before we were ready to honor them).
    const active = dv.activePanel;
    setFocused(active ? parsePanelId(active.id) : null);
    refreshVisibleSet(dv);
    // Persist the (possibly migrated) layout right away.
    try {
      saveLayout(project.id, dv.toJSON());
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock, dataReady, project.id]);

  // Recompute the visible-session set from each group's selected tab.
  // Cheap (groups are few); identity-preserving so downstream effects only
  // fire on real changes.
  function refreshVisibleSet(dv: DockviewApi) {
    const next = new Set<string>();
    for (const g of dv.groups) {
      const ref = g.activePanel ? parsePanelId(g.activePanel.id) : null;
      if (ref?.kind === 'session') next.add(ref.id);
    }
    setVisibleSet((prev) => {
      if (prev.size === next.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }

  function onDockReady(event: DockviewReadyEvent) {
    dockRef.current = event.api;
    setDock(event.api);
    event.api.onDidActivePanelChange((panel) => {
      setFocused(panel ? parsePanelId(panel.id) : null);
      refreshVisibleSet(event.api);
    });
    event.api.onDidLayoutChange(() => {
      refreshVisibleSet(event.api);
      if (!builtRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        // A late timer from a dock that's been replaced (project switch
        // remounts DockviewReact) must not run — toJSON on a disposed dock
        // can serialize an EMPTY grid and clobber the old project's saved
        // layout. dockRef always points at the live dock.
        if (dockRef.current !== event.api) return;
        try {
          saveLayout(project.id, event.api.toJSON());
        } catch {
          // dock disposed mid-debounce — drop the save
        }
        syncSessionOrder(event.api);
      }, 300);
    });
  }

  // Clear any pending debounced save when the project changes (ProjectPage
  // does NOT unmount on a project switch — only the keyed DockviewReact
  // does) and on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [project.id]);

  // ─── single-active chokepoints (unchanged semantics) ───

  // Remember last active session per project (move-session pre-seeds the
  // target project's key; also keeps rollback to the legacy strip sane).
  useEffect(() => {
    if (!activeSession) return;
    localStorage.setItem(`pinloom:lastSession:${project.id}`, activeSession.id);
  }, [project.id, activeSession?.id]);

  // Publish the focused session (pins rail / bottom panel scope) and the
  // full visible set (chat-done suppression + read-state across splits).
  // Every session the user can SEE counts as checked — a tab landing on
  // screen is what confirms its agent notifications.
  const visibleSessionId = activeSession?.id ?? null;
  useEffect(() => {
    setActiveSessionId(visibleSessionId);
    return () => setActiveSessionId(null);
  }, [visibleSessionId]);

  useEffect(() => {
    setVisibleSessionIds(visibleSet);
    for (const id of visibleSet) markSessionRead(id);
    return () => setVisibleSessionIds(new Set());
  }, [visibleSet, markSessionRead]);

  // Cover the "session was on screen but window hidden when the agent
  // finished" case: the visible-set effect above didn't re-run because the
  // set never changed. When the user returns to the window, retroactively
  // confirm chat-done items for every session they can see.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      for (const id of visibleSet) markSessionRead(id);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [visibleSet, markSessionRead]);

  function handlePinsChange(updated: Message) {
    // Mutate the per-session SWR key — every consumer (each session panel's
    // right rail, pop-out pins page) reads through it. On a cache MISS
    // (pin event for a session whose pins were never fetched) follow up
    // with a revalidation so the rail doesn't flash a one-pin partial list.
    let hadCache = true;
    void globalMutate(
      cacheKeys.sessionPins(updated.sessionId),
      (prev: Message[] | undefined) => {
        hadCache = prev !== undefined;
        return applyPinChange(prev ?? [], updated);
      },
      { revalidate: false },
    ).then(() => {
      if (!hadCache) void globalMutate(cacheKeys.sessionPins(updated.sessionId));
    });
  }

  // ─── out-of-band session arrivals ───

  // Live-append sessions created out-of-band for this project (e.g. an
  // orchestrator spawning a worker via MCP). We append but DON'T switch to
  // it — the user didn't open it, so don't yank their active view.
  useWebSocket(`project:${project.id}`, (ev) => {
    if (ev.type === 'session_created' && ev.projectId === project.id) {
      spliceInSession(ev.session);
    } else if (ev.type === 'session_deleted' && ev.projectId === project.id) {
      // Deleted from another window (or the backend) — drop the tab live.
      // Idempotent for the window that initiated the delete (filter no-ops,
      // panel already gone).
      removeSessionLocally(ev.sessionId);
      // A run aborted by the delete resolves after the row is gone, so its
      // terminal run_activity is swallowed — clear both the tab dot and the
      // bell's "in progress" entry so neither strands a dead session.
      setSessionRunning(ev.sessionId, false);
      dismissNotification(runningNotifId(ev.sessionId));
    }
  });

  // A session created via an inline modal (e.g. the AddWorker form's
  // "Create new session" button) dispatches this window event.
  useEffect(() => {
    function onSessionCreated(event: Event) {
      const detail = (event as CustomEvent<{ session: Session }>).detail;
      const s = detail?.session;
      if (!s || s.projectId !== project.id) return;
      spliceInSession(s);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  function spliceInSession(s: Session) {
    setSessions((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
    // Pre-build arrivals are picked up by the build's reconcile pass.
    if (builtRef.current) {
      // setSessions hasn't flushed to sessionsRef yet — add directly.
      const dv = dockRef.current;
      if (dv && !dv.getPanel(panelId('session', s.id))) {
        const lastGroup = dv.groups[dv.groups.length - 1]?.id ?? null;
        dv.addPanel({
          id: panelId('session', s.id),
          component: isTerminalAgentSession(s) ? 'terminal' : 'chat',
          params: { kind: 'session', sessionId: s.id },
          inactive: true,
          // Anchor so an inactive add can never open a surprise split.
          ...(lastGroup ? { position: { referenceGroup: lastGroup } } : {}),
        });
      }
    }
  }

  // Canvas "go to tab" button. Cross-project navigation is handled by the
  // canvas via navigate() + lastSession seeding; for same-project jumps the
  // route doesn't change, so we listen here and focus the panel in-place.
  useEffect(() => {
    function onGoto(event: Event) {
      const detail = (
        event as CustomEvent<{ projectId: string; sessionId: string }>
      ).detail;
      if (!detail || detail.projectId !== project.id) return;
      const target = sessionsRef.current.find(
        (s) => s.id === detail.sessionId,
      );
      if (!target) return;
      const dv = dockRef.current;
      const panel = dv?.getPanel(panelId('session', target.id));
      if (panel) panel.api.setActive();
      else addSessionPanel(target);
    }
    window.addEventListener('pinloom:goto-session', onGoto as EventListener);
    return () =>
      window.removeEventListener(
        'pinloom:goto-session',
        onGoto as EventListener,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // ─── tab/panel actions ───

  async function createSessionTab(agent: AgentKind, groupId: string | null) {
    try {
      // Leave the title null so the tab renders as "Chat <6char-suffix>" —
      // keeps suffixes unique across many "new" sessions.
      const created = await api.createSession(project.id, {
        title: null,
        agent,
      });
      setSessions((prev) => [...prev, created]);
      addSessionPanel(created, { groupId });
    } catch (err) {
      setStripError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createNotepadTab(groupId: string | null) {
    try {
      const created = await projectNotepadApi.create(project.id);
      const summary: ProjectNotepadSummary = {
        id: created.id,
        projectId: created.projectId,
        name: created.name,
        position: created.position,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
      setNotepads((prev) => [...prev, summary]);
      addNotepadPanel(created.id, { groupId });
    } catch {
      // surfaced server-side; leave the dock unchanged
    }
  }

  function openCanvasTab(tab: InlineCanvasTab) {
    setCanvasTabs((prev) => {
      const next = prev.some((c) => c.teamId === tab.teamId)
        ? prev
        : [...prev, tab];
      persistCanvasTabs(project.id, next);
      return next;
    });
    addCanvasPanel(tab.teamId);
  }

  function closeCanvas(teamId: string) {
    setCanvasTabs((prev) => {
      const next = prev.filter((c) => c.teamId !== teamId);
      persistCanvasTabs(project.id, next);
      return next;
    });
    removePanelFor('canvas', teamId);
  }

  async function deleteNotepad(id: string) {
    try {
      await projectNotepadApi.remove(id);
    } catch {
      // ignore — fall through and drop it from the UI anyway
    }
    setNotepads((prev) => prev.filter((n) => n.id !== id));
    removePanelFor('notepad', id);
  }

  function renameNotepad(id: string, name: string) {
    setNotepads((prev) => prev.map((n) => (n.id === id ? { ...n, name } : n)));
    void projectNotepadApi.update(id, { name }).catch(() => {
      // optimistic; a failed rename just reverts on next load
    });
  }

  async function renameSession(sessionId: string, title: string | null) {
    try {
      const updated = await api.renameSession(sessionId, title);
      onSessionUpdate(updated);
    } catch (err) {
      setStripError(err instanceof Error ? err.message : String(err));
    }
  }

  function onSessionUpdate(updated: Session) {
    setSessions((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s)),
    );
  }

  function removeSessionLocally(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    removePanelFor('session', sessionId);
  }

  // Menu "Delete tab" — the API delete plus local/panel cleanup. The menu
  // already confirmed with the user.
  async function deleteSessionTab(sessionId: string) {
    await api.deleteSession(sessionId);
    removeSessionLocally(sessionId);
  }

  // The user clicked "Close tab" on a terminal session's exit overlay (its
  // TUI quit). Closing the tab means deleting the session — the overlay is
  // the confirm. Durable knowledge lives in the wiki, so a finished session
  // is meant to be cleared.
  function closeTerminalSession(id: string) {
    void api.deleteSession(id).catch(() => {
      // best-effort: the pty already exited; a failed delete just leaves
      // the row.
    });
    removeSessionLocally(id);
  }

  // Menu "Switch to terminal/chat mode" — flips the transport server-side
  // (conversation carries via the resume token), then swaps the panel: the
  // dockview component (chat vs terminal) is fixed at addPanel time, so the
  // panel is re-created in place with the new component.
  async function convertTransport(sessionId: string, to: 'sdk' | 'terminal') {
    const { session: updated, resumeCarried } =
      await api.convertSessionTransport(sessionId, to);
    onSessionUpdate(updated);
    const dv = dockRef.current;
    if (dv) {
      const panel = dv.getPanel(panelId('session', sessionId));
      // Recreate next to where it lived so the layout doesn't jump. try/finally:
      // the component (chat vs terminal) is fixed at addPanel time, so we must
      // remove+re-add — but a re-add failure must never leave the tab vanished.
      const groupId = liveGroupId(dv, panel?.group.id ?? null);
      try {
        if (panel) dv.removePanel(panel);
      } finally {
        addSessionPanel(updated, { groupId });
      }
    }
    if (!resumeCarried) {
      // History is intact, but the agent couldn't carry its prior thread
      // (e.g. a codex orchestrator's transient SDK home). Don't let it be a
      // silent context loss.
      setStripError(
        'Converted — conversation history kept, but the agent starts a fresh thread (prior context not carried).',
      );
    }
  }

  // Menu "Split right/down" — the non-drag path to a side-by-side. Moves the
  // session's panel into a new group next to its current one. dockview
  // collapses the old group automatically if this was its only panel.
  function splitSessionPanel(sessionId: string, direction: 'right' | 'down') {
    const dv = dockRef.current;
    const panel = dv?.getPanel(panelId('session', sessionId));
    if (!panel) return;
    panel.api.moveTo({
      group: panel.group,
      position: direction === 'right' ? 'right' : 'bottom',
    });
  }

  function onHandoff(newSession: Session) {
    setSessions((prev) =>
      prev.some((s) => s.id === newSession.id) ? prev : [...prev, newSession],
    );
    const dv = dockRef.current;
    if (dv && !dv.getPanel(panelId('session', newSession.id))) {
      dv.addPanel({
        id: panelId('session', newSession.id),
        component: isTerminalAgentSession(newSession) ? 'terminal' : 'chat',
        params: { kind: 'session', sessionId: newSession.id },
      });
    }
  }

  // ─── dock context ───

  const sessionsById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );
  const canvasesById = useMemo(
    () => new Map(canvasTabs.map((c) => [c.teamId, c])),
    [canvasTabs],
  );
  const notepadsById = useMemo(
    () => new Map(notepads.map((n) => [n.id, n])),
    [notepads],
  );

  const dockContext: DockContextValue = {
    projectId: project.id,
    projectName: project.name,
    projectCwd: project.cwd,
    sessionsById,
    canvasesById,
    notepadsById,
    rolesBySessionId,
    teams,
    sessionCount: sessions.length,
    codexAvailable,
    // Re-clicking the open menu's own trigger toggles it closed (parity with
    // the legacy strip).
    openTabMenu: (req) =>
      setTabMenu((prev) =>
        prev && prev.sessionId === req.sessionId ? null : req,
      ),
    renameSession,
    renameNotepad,
    closeCanvas,
    deleteNotepad,
    createSessionTab: (agent, groupId) => void createSessionTab(agent, groupId),
    createNotepadTab: (groupId) => void createNotepadTab(groupId),
    onSessionUpdate,
    onPinChange: handlePinsChange,
    onHandoff,
    onSendPin: (sessionId, pin) => setSendingPin({ pin, sessionId }),
    closeTerminalSession,
  };

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
        {stripError && (
          <button
            type="button"
            onClick={() => setStripError(null)}
            className="ml-auto text-xs text-red-400 truncate max-w-[320px]"
            title={`${stripError} (click to dismiss)`}
          >
            {stripError}
          </button>
        )}
      </header>

      {/* Dock fills the workspace. Pins now live in each session panel's right
          rail (TerminalSidePanel) for BOTH terminal and SDK sessions, so there's
          no separate left pin rail — and under splits each pane shows its own. */}
      <div className="flex-1 flex min-h-0">
        <DockProvider value={dockContext}>
          <div className="h-full w-full">
            <DockviewReact
              key={project.id}
              onReady={onDockReady}
              components={DOCK_COMPONENTS}
              defaultTabComponent={ProjectTab}
              // left = immediately AFTER the last tab (dockview renders the
              // left-actions container between the tabs and the void), which
              // is where the legacy strip kept its '+' button.
              leftHeaderActionsComponent={GroupActions}
              watermarkComponent={DockWatermark}
              theme={themeDark}
            />
          </div>
        </DockProvider>
      </div>

      {activeSession && (
        <BottomPanel
          key={project.id}
          projectId={project.id}
          session={activeSession}
        />
      )}

      <TabMenuHost
        projectId={project.id}
        sessions={sessions}
        menu={tabMenu}
        onCloseMenu={() => setTabMenu(null)}
        onDeleteSession={deleteSessionTab}
        onSessionMovedAway={removeSessionLocally}
        onSplit={splitSessionPanel}
        onConvertTransport={convertTransport}
        onOpenCanvasTab={openCanvasTab}
        onError={setStripError}
      />

      {sendingPin && (
        <SessionPickerModal
          pin={sendingPin.pin}
          projectId={project.id}
          sessions={sessions}
          currentSessionId={sendingPin.sessionId}
          onClose={() => setSendingPin(null)}
          onNewSessionCreated={(s) => spliceInSession(s)}
        />
      )}
    </div>
  );
}
