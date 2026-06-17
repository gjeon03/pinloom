import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  BookPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  LayoutGrid,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pin,
} from 'lucide-react';
import type { Message, Session, WsEvent } from '@pinloom/shared';
import { api, type WikiPage } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import {
  isVerticalRail,
  setSidePanelPosition,
  type SidePanelPosition,
} from '../hooks/useSidePanelPosition.js';
import { useNotifications } from '../stores/notifications.js';
import { ActionIconButton, CopyMarkdownButton, PinToggleButton } from './MessageActions.js';
import { PinnedPanel } from './PinnedPanel.js';

// Right rail for a session, shared by terminal AND structured (SDK) sessions:
//   - History: the captured turns, with a quick pin toggle. TERMINAL ONLY —
//     the TUI is ephemeral so the DB capture is the only scrollback; an SDK
//     session's ChatView already shows the full conversation, so SDK callers
//     omit this tab (pass tabs={['pins','wiki']}).
//   - Pins: the FULL pin manager, reusing the shared PinnedPanel verbatim (title
//     edit, expand/detail, copy, download, send-to-session, handoff).
//   - Wiki: sync this session + relevant project wiki pages.
// Pins inject into the session's system prompt on its NEXT launch (for terminal,
// the running TUI keeps its launch-time prompt), so a freshly-pinned note
// reaches the agent after the session is reopened / resumed.

type Tab = 'history' | 'pins' | 'wiki';
const ALL_TABS: Tab[] = ['history', 'pins', 'wiki'];

const collapsedKey = (sid: string) => `pinloom:termpanel:collapsed:${sid}`;
const tabKey = (sid: string) => `pinloom:termpanel:tab:${sid}`;

function isTab(v: string | null): v is Tab {
  return v === 'history' || v === 'pins' || v === 'wiki';
}

// Mirror of backend computeWikiSlug (basename of cwd, slugified). We skip the
// rare same-basename collision suffix — at worst the relevant-pages list shows a
// few extra pages; the full wiki (with proper scope filters) is one click away.
function projectSlug(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? cwd;
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// How many history rows to render initially / per "show older" step. Most opens
// want the latest turns (mirrors the terminal scrollback + ChatView), so we
// render the newest WINDOW and page older history in on scroll-up.
const WINDOW = 60;

// Drag-to-resize: preferences shared across sessions. Width drives left/right
// rails; height drives top/bottom slabs (kept as a separate key so flipping
// orientation restores a sane size for that axis).
const WIDTH_KEY = 'pinloom:termpanel:width';
const MIN_W = 240;
const MAX_W = 720;
const DEFAULT_W = 320;
const HEIGHT_KEY = 'pinloom:termpanel:height';
const MIN_H = 140;
const MAX_H = 560;
const DEFAULT_H = 240;

function preview(content: string, max = 600): string {
  const t = content.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface Props {
  sessionId: string;
  /** Authoritative pin list for this session (from ProjectPage's SWR). */
  pins: Message[];
  /** Propagate a pin add/remove/title change up to the shared pins state. */
  onPinChange: (message: Message) => void;
  projectName: string;
  /** Project directory — basename drives the wiki scope slug. */
  projectCwd: string;
  onHandoff?: (newSession: Session) => void;
  onSendPin?: (pin: Message) => void;
  /** Which tabs to show, in order. Defaults to all three (terminal). SDK
   *  sessions pass ['pins','wiki'] — their ChatView already shows history. */
  tabs?: Tab[];
  /** Which edge the rail docks to (global preference from the parent). */
  position?: SidePanelPosition;
}

export function TerminalSidePanel({
  sessionId,
  pins,
  onPinChange,
  projectName,
  projectCwd,
  onHandoff,
  onSendPin,
  tabs = ALL_TABS,
  position = 'right',
}: Props) {
  const hasHistory = tabs.includes('history');
  const vertical = isVerticalRail(position);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(tabKey(sessionId));
    return isTab(saved) && tabs.includes(saved) ? saved : tabs[0];
  });
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(collapsedKey(sessionId)) === '1',
  );
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(WINDOW);
  // Per-message "show full content" toggles (history rows truncate by default).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Drag-resizable size (clamped, persisted globally). Width for vertical
  // rails, height for horizontal slabs.
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
  });
  const [height, setHeight] = useState(() => {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_H && v <= MAX_H ? v : DEFAULT_H;
  });
  const [dragging, setDragging] = useState(false);
  // Position picker popover (next to the collapse button).
  const [pickerOpen, setPickerOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  // The panel edge held fixed during a drag (opposite the drag handle).
  const dragAnchorRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-bottom: true while the user is parked at the latest turn. Opening the
  // panel and new live turns scroll to the bottom; once the user scrolls up to
  // read history we stop yanking them back down.
  const stick = useRef(true);
  // When we page in older rows (limit↑), the content above the viewport grows —
  // record the pre-grow scrollHeight so a layout effect can re-anchor and keep
  // the rows the user is looking at from jumping.
  const prependAnchor = useRef<number | null>(null);

  useEffect(() => {
    if (!hasHistory) return; // SDK sessions: ChatView owns the conversation
    let cancelled = false;
    api
      .listMessages(sessionId)
      .then((m) => {
        if (!cancelled) setMessages(m);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, hasHistory]);

  const onWsEvent = useCallback(
    (ev: WsEvent) => {
      if (!hasHistory) return; // history not shown — nothing to keep in sync
      if (ev.type === 'message' && ev.sessionId === sessionId) {
        setMessages((prev) =>
          prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
        );
      } else if (ev.type === 'message_updated' && ev.sessionId === sessionId) {
        setMessages((prev) => prev.map((m) => (m.id === ev.message.id ? ev.message : m)));
      }
    },
    [sessionId, hasHistory],
  );
  useWebSocket(`session:${sessionId}`, onWsEvent);

  // Drag-to-resize. The size is the distance from the cursor to the panel's
  // (drag-fixed) anchor edge — the edge opposite the drag handle. Mirrors
  // HSplitter's body cursor / user-select handling. AgentTerminal's container
  // ResizeObserver re-fits the xterm automatically as the panel resizes.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (vertical) {
        // right rail grows leftward (anchor=right edge); left rail rightward.
        const raw =
          position === 'right'
            ? dragAnchorRef.current - e.clientX
            : e.clientX - dragAnchorRef.current;
        const next = Math.max(MIN_W, Math.min(MAX_W, raw));
        setWidth(next);
        localStorage.setItem(WIDTH_KEY, String(next));
      } else {
        // bottom slab grows upward (anchor=bottom edge); top slab downward.
        const raw =
          position === 'bottom'
            ? dragAnchorRef.current - e.clientY
            : e.clientY - dragAnchorRef.current;
        const next = Math.max(MIN_H, Math.min(MAX_H, raw));
        setHeight(next);
        localStorage.setItem(HEIGHT_KEY, String(next));
      }
    }
    function onUp() {
      setDragging(false);
    }
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, vertical, position]);

  // Quick pin/unpin from the history list. Updates this panel's own copy AND the
  // shared pins state so the Pins tab / left rail reflect it immediately (the
  // backend also broadcasts message_updated, which keeps both in sync anyway).
  const togglePin = useCallback(
    async (m: Message) => {
      try {
        const updated = await api.updateMessage(m.id, { pinned: !m.pinned });
        setMessages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        onPinChange(updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onPinChange],
  );

  function persistCollapsed(next: boolean) {
    setCollapsed(next);
    localStorage.setItem(collapsedKey(sessionId), next ? '1' : '0');
  }
  function selectTab(next: Tab) {
    setTab(next);
    localStorage.setItem(tabKey(sessionId), next);
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rows = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );
  const pinCount = pins.length;
  // Render only the newest `limit` rows; older history pages in on scroll-up.
  const hasOlder = rows.length > limit;
  const windowed = hasOlder ? rows.slice(rows.length - limit) : rows;

  // Stick to the bottom on open and on new live turns — unless the user has
  // scrolled up to read history. Runs after the windowed list paints. No-ops
  // when the History tab isn't mounted (scrollRef null).
  useLayoutEffect(() => {
    if (tab !== 'history') return; // History is hidden (display:none) on other tabs
    if (prependAnchor.current !== null) return; // a load-older paint owns this frame
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [windowed.length, collapsed, tab]);

  // Re-anchor after paging in older rows so the viewport doesn't jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prependAnchor.current !== null) {
      el.scrollTop += el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    }
  }, [limit]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    // Near the top with more history available → page in the next older chunk.
    // Skip if a prior page-in is still settling (prependAnchor not yet consumed)
    // so one scroll gesture doesn't stack several limit bumps.
    if (el.scrollTop < 80 && hasOlder && prependAnchor.current === null) {
      prependAnchor.current = el.scrollHeight;
      setLimit((n) => n + WINDOW);
    }
  }

  // Border on the content-facing edge so the rail reads as docked to `position`.
  const contentBorder =
    position === 'right'
      ? 'border-l'
      : position === 'left'
        ? 'border-r'
        : position === 'top'
          ? 'border-b'
          : 'border-t';
  const collapsedTitle = hasHistory
    ? 'Show history, pins & wiki'
    : 'Show pins & wiki';

  if (collapsed) {
    // Expand chevron points inward (toward the content), per docked edge.
    const ExpandIcon =
      position === 'right'
        ? ChevronLeft
        : position === 'left'
          ? ChevronRight
          : position === 'top'
            ? ChevronDown
            : ChevronUp;
    return (
      <button
        type="button"
        onClick={() => persistCollapsed(false)}
        title={collapsedTitle}
        aria-label={collapsedTitle}
        // Anchor the icons at the start of the strip — top for a vertical
        // rail, left for a horizontal one — rather than floating in the
        // center. Icons (pin / wiki, plus history for terminal) read cleaner
        // than the old sideways text.
        className={`flex shrink-0 items-center justify-start gap-2 ${contentBorder} border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] ${
          vertical ? 'h-full w-8 flex-col py-2' : 'h-8 w-full flex-row px-2'
        }`}
      >
        <ExpandIcon className="h-4 w-4" />
        {hasHistory && <History className="h-4 w-4" />}
        <span className="relative inline-flex">
          <Pin className="h-4 w-4" />
          {pinCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[var(--color-accent)] px-1 text-[9px] leading-[1.2] text-black">
              {pinCount}
            </span>
          )}
        </span>
        <BookOpen className="h-4 w-4" />
      </button>
    );
  }

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => selectTab(id)}
      // Active underline via inset shadow (not border-b) so it doesn't add to
      // the button's box height. Fixed h-8 matches the right-side icon buttons
      // so header `items-center` lines everything up exactly.
      className={`flex h-8 items-center px-2.5 text-[11px] ${
        tab === id
          ? 'text-[var(--color-ink)] shadow-[inset_0_-2px_0_0_var(--color-accent)]'
          : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </button>
  );

  // Drag handle sits on the content-facing edge (same side as contentBorder);
  // the opposite (outer) edge is the fixed anchor during a resize.
  const handleClass = vertical
    ? `inset-y-0 ${position === 'right' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'} w-2 cursor-col-resize`
    : `inset-x-0 ${position === 'bottom' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2'} h-2 cursor-row-resize`;
  const handleLineClass = vertical
    ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
    : 'inset-x-0 top-1/2 h-px -translate-y-1/2';
  const CollapseIcon =
    position === 'right'
      ? ChevronRight
      : position === 'left'
        ? ChevronLeft
        : position === 'top'
          ? ChevronUp
          : ChevronDown;

  // Fixed-size cells so the 4 edges lay out as a clear square D-pad (top
  // center, left/right middle, bottom center) — easy to read and to click.
  const posBtn = (p: SidePanelPosition, Icon: typeof PanelRight, label: string) => (
    <button
      type="button"
      onClick={() => {
        setSidePanelPosition(p);
        setPickerOpen(false);
      }}
      title={`Dock ${label.toLowerCase()}`}
      aria-label={`Dock ${label.toLowerCase()}`}
      className={`flex h-9 w-9 items-center justify-center rounded border ${
        position === p
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-black'
          : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );

  return (
    <aside
      ref={asideRef}
      style={vertical ? { width } : { height }}
      className={`relative flex shrink-0 flex-col ${contentBorder} border-[var(--color-border)] bg-[var(--color-surface)] ${
        vertical ? 'h-full' : 'w-full'
      }`}
    >
      {/* Drag handle on the content-facing edge — resizes the panel. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const r = asideRef.current?.getBoundingClientRect();
          if (r) {
            dragAnchorRef.current =
              position === 'right'
                ? r.right
                : position === 'left'
                  ? r.left
                  : position === 'bottom'
                    ? r.bottom
                    : r.top;
          }
          setDragging(true);
        }}
        title="Drag to resize"
        className={`group absolute z-20 ${handleClass} ${
          dragging ? 'bg-[var(--color-accent)]' : ''
        }`}
      >
        <div
          className={`absolute ${handleLineClass} ${
            dragging ? 'bg-[var(--color-accent)]' : 'group-hover:bg-[var(--color-accent)]/50'
          }`}
        />
      </div>
      <header className="flex items-center justify-between border-b border-[var(--color-border)] pr-1">
        <div className="flex items-center">
          {tabs.includes('history') && tabBtn('history', 'History')}
          {tabs.includes('pins') &&
            tabBtn('pins', pinCount > 0 ? `Pins ${pinCount}` : 'Pins')}
          {tabs.includes('wiki') && tabBtn('wiki', 'Wiki')}
        </div>
        <div className="flex items-center gap-0.5">
          {/* Position picker — dock the rail to any edge. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              title="Panel position"
              aria-label="Panel position"
              className="flex h-8 items-center px-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            {pickerOpen && (
              <>
                {/* Click-away overlay. */}
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setPickerOpen(false)}
                />
                <div className="absolute right-0 top-full z-40 mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 shadow-lg">
                  {/* Fixed track sizes — `grid-cols-3` (1fr) collapses to 0 in
                      a shrink-wrapped absolute popover. */}
                  <div
                    className="grid gap-1"
                    style={{
                      gridTemplateColumns: 'repeat(3, 2.25rem)',
                      gridTemplateRows: 'repeat(3, 2.25rem)',
                    }}
                  >
                    <span />
                    {posBtn('top', PanelTop, 'Top')}
                    <span />
                    {posBtn('left', PanelLeft, 'Left')}
                    <span className="flex items-center justify-center text-[9px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                      Dock
                    </span>
                    {posBtn('right', PanelRight, 'Right')}
                    <span />
                    {posBtn('bottom', PanelBottom, 'Bottom')}
                    <span />
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => persistCollapsed(true)}
            title="Collapse"
            className="flex h-8 items-center px-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <CollapseIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}

      {/* History stays mounted (hidden when inactive) so its scroll position and
          sticky-bottom refs survive tab switches; Pins/Wiki mount on demand.
          Omitted entirely for SDK sessions (no 'history' tab). */}
      {hasHistory && (
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'history' ? '' : 'hidden'}`}>
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto px-2 py-2">
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-[var(--color-ink-muted)]">
                Captured turns appear here as you chat.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {hasOlder && (
                  <li className="py-1 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        const el = scrollRef.current;
                        if (el) prependAnchor.current = el.scrollHeight;
                        setLimit((n) => n + WINDOW);
                      }}
                      className="text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                    >
                      Show older ({rows.length - limit})
                    </button>
                  </li>
                )}
                {windowed.map((m) => {
                  if (m.role === 'tool') {
                    return (
                      <li
                        key={m.id}
                        className="truncate px-2 text-[10px] text-[var(--color-ink-muted)]"
                        title={m.content}
                      >
                        $ {m.content}
                      </li>
                    );
                  }
                  const isAssistant = m.role === 'assistant';
                  const isOpen = expanded.has(m.id);
                  const long = m.content.trim().length > 600;
                  return (
                    <li
                      key={m.id}
                      className={`group relative rounded border px-2 py-1.5 text-xs ${
                        m.pinned
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                          : 'border-[var(--color-border)]/50'
                      }`}
                    >
                      <div className="mb-0.5 flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                          {isAssistant ? 'Assistant' : 'You'}
                        </span>
                        <div className="flex items-center gap-0.5">
                          <span className="opacity-0 transition-opacity group-hover:opacity-100">
                            <CopyMarkdownButton content={m.content} size="sm" />
                          </span>
                          {long && (
                            <ActionIconButton
                              onClick={() => toggleExpand(m.id)}
                              title={isOpen ? 'Collapse' : 'Expand'}
                              size="sm"
                            >
                              {isOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                            </ActionIconButton>
                          )}
                          <PinToggleButton
                            pinned={m.pinned}
                            onClick={() => togglePin(m)}
                            size="sm"
                            hoverOnly={!m.pinned}
                          />
                        </div>
                      </div>
                      <div className="whitespace-pre-wrap break-words text-[var(--color-ink)]">
                        {isOpen ? m.content.trim() : preview(m.content)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <footer className="border-t border-[var(--color-border)]/50 px-3 py-1.5 text-[9px] text-[var(--color-ink-muted)]">
            Pins apply on the session's next launch (the live TUI keeps its launch-time prompt).
          </footer>
      </div>
      )}

      {tab === 'pins' && (
        <div className="min-h-0 flex-1">
          <PinnedPanel
            pins={pins}
            onChange={onPinChange}
            sessionId={sessionId}
            projectName={projectName}
            showPopOut
            onHandoff={onHandoff}
            onSendPin={onSendPin}
          />
        </div>
      )}
      {tab === 'wiki' && <WikiTab sessionId={sessionId} projectCwd={projectCwd} />}
    </aside>
  );
}

// Wiki tab: the per-session "sync to wiki" action ChatView's header gives
// structured sessions (the one wiki affordance terminal mode lacked), plus this
// project's relevant pages with links into the full wiki. Wiki CONTEXT is already
// injected into the launch prompt by the backend, so this is purely the UI.
function WikiTab({ sessionId, projectCwd }: { sessionId: string; projectCwd: string }) {
  const navigate = useNavigate();
  const notifications = useNotifications();
  const [syncing, setSyncing] = useState(false);
  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slug = projectSlug(projectCwd);

  const loadPages = useCallback(async () => {
    try {
      const o = await api.wikiOverview();
      setPages(o.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  const relevant = (pages ?? []).filter((p) => {
    const a = p.meta.appliesTo;
    return a.length === 0 || a.includes('global') || a.includes(slug);
  });

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    const id = notifications.start({
      kind: 'wiki-sync',
      title: 'Wiki sync',
      meta: { sessionId },
    });
    try {
      const result = await api.syncWiki(sessionId);
      notifications.resolve(id, result.output);
      void loadPages(); // surface any newly written pages in the list
    } catch (err) {
      notifications.fail(id, err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-3">
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        aria-busy={syncing}
        className="flex items-center justify-center gap-2 rounded border border-[var(--color-accent)]/50 bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        <BookPlus className={`h-4 w-4 ${syncing ? 'animate-pulse' : ''}`} />
        {syncing ? 'Syncing…' : 'Sync this session to wiki'}
      </button>
      <p className="text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
        Distills durable knowledge from this conversation into the project wiki
        (~/.pinloom/wiki), which is injected into every future session's prompt.
      </p>

      <div className="flex items-center justify-between border-t border-[var(--color-border)]/50 pt-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
          Pages for {slug}
        </span>
        <button
          type="button"
          onClick={() => navigate('/wiki')}
          className="flex items-center gap-1 text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <BookOpen className="h-3 w-3" /> Open wiki
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {pages === null ? (
        <p className="px-1 text-xs text-[var(--color-ink-muted)]">Loading…</p>
      ) : relevant.length === 0 ? (
        <p className="px-1 text-xs text-[var(--color-ink-muted)]">
          No wiki pages for this project yet. Sync above to create some.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {relevant.map((p) => (
            <li key={p.relPath}>
              <button
                type="button"
                onClick={() => navigate(`/wiki/${encodeURIComponent(p.relPath)}`)}
                className="w-full rounded border border-[var(--color-border)]/50 px-2 py-1.5 text-left text-xs hover:border-[var(--color-accent)]"
              >
                <div className="truncate text-[var(--color-ink)]">{p.title || p.relPath}</div>
                {p.meta.summary && (
                  <div className="truncate text-[10px] text-[var(--color-ink-muted)]">
                    {p.meta.summary}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
