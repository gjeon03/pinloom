import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BookPlus, Check, CircleAlert, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import {
  useNotifications,
  type NotificationItem,
  type NotificationKind,
} from '../stores/notifications.js';
import { gotoSessionTab } from '../utils/gotoSession.js';
import { NotificationDetail } from './NotificationDetail.js';

function formatRelative(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function kindIcon(kind: NotificationKind) {
  if (kind === 'wiki-sync') return <BookPlus size={12} />;
  if (kind === 'wiki-analyze') return <Sparkles size={12} />;
  if (kind === 'chat-done') return <MessageSquare size={12} />;
  return <Bell size={12} />;
}

function statusIcon(item: NotificationItem) {
  if (item.status === 'running') {
    return <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />;
  }
  if (item.status === 'success') {
    return <Check size={12} className="text-emerald-400" />;
  }
  return <CircleAlert size={12} className="text-red-400" />;
}

type RecentFilter = 'all' | 'unread' | 'read';

const PAGE_SIZE = 20;

export function NotificationCenter() {
  const {
    items,
    runningCount,
    unreadCount,
    dismiss,
    markRead,
    markAllRead,
    clearFinished,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RecentFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Chat-done notifications jump to the session's tab; everything else opens
  // its detail panel.
  function openItem(it: NotificationItem) {
    markRead(it.id);
    setOpen(false);
    if (it.kind === 'chat-done' && it.meta?.sessionId && it.meta?.projectId) {
      gotoSessionTab(navigate, it.meta.projectId, it.meta.sessionId);
      return;
    }
    setSelectedId(it.id);
  }

  // Re-render once a second while there are running items so "Xs ago" stays fresh
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (runningCount === 0 && items.every((it) => Date.now() - (it.finishedAt ?? it.startedAt) > 60_000)) {
      return;
    }
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [runningCount, items]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const running = items.filter((it) => it.status === 'running');
  const recent = items.filter((it) => it.status !== 'running');

  const filteredRecent = useMemo(() => {
    if (filter === 'all') return recent;
    if (filter === 'read') return recent.filter((it) => it.read);
    return recent.filter((it) => !it.read);
  }, [recent, filter]);
  const visibleRecent = filteredRecent.slice(0, visibleCount);
  const hasMoreRecent = filteredRecent.length > visibleCount;

  // Switching filters or closing the dropdown resets the slide window so
  // a stray `visibleCount` doesn't leak across views — opening again starts
  // at PAGE_SIZE every time.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, open]);

  // Infinite scroll: when the sentinel below the last visible row enters
  // the dropdown's scroll area, request +PAGE_SIZE more. The effect deps
  // include `visibleCount` so the observer is torn down + re-created after
  // every bump — that resets the observer's intersection state so a
  // sentinel that's still on-screen after the new rows render won't keep
  // re-firing in a cascade. The setter also clamps to filteredRecent.length
  // as a defense-in-depth bound.
  useEffect(() => {
    if (!open || !hasMoreRecent) return;
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((n) =>
            Math.min(n + PAGE_SIZE, filteredRecent.length),
          );
        }
      },
      { root, rootMargin: '0px 0px 80px 0px' },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [open, hasMoreRecent, filteredRecent.length, visibleCount]);

  const showBadge = runningCount > 0 || unreadCount > 0;
  const badgeCount = runningCount + unreadCount;
  const selectedItem = selectedId ? items.find((it) => it.id === selectedId) ?? null : null;

  function toggleOpen() {
    // Run the side-effect outside the updater so we don't update
    // NotificationProvider's state from inside NotificationCenter's render.
    const next = !open;
    setOpen(next);
    if (next) markAllRead();
  }

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={toggleOpen}
          title="Notifications"
          className="relative rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 backdrop-blur-sm p-2 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] shadow-md"
        >
          <Bell
            size={14}
            className={runningCount > 0 ? 'animate-pulse text-[var(--color-accent)]' : ''}
          />
          {showBadge && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-accent)] text-black text-[10px] font-semibold flex items-center justify-center">
              {badgeCount}
            </span>
          )}
        </button>

        {open && (
          <div
            ref={scrollRef}
            className="absolute top-full right-0 mt-2 w-80 max-h-[70vh] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
          >
            <div className="sticky top-0 z-10 bg-[var(--color-surface-2)]/95 backdrop-blur-sm border-b border-[var(--color-border)]">
              <header className="px-3 py-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Notifications
                </span>
                {recent.length > 0 && (
                  <button
                    type="button"
                    onClick={clearFinished}
                    className="text-[10px] text-[var(--color-ink-muted)] hover:text-red-400"
                  >
                    Clear finished
                  </button>
                )}
              </header>
              <div className="px-3 py-1.5 border-t border-[var(--color-border)]/40 flex gap-1">
                {(['all', 'unread', 'read'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`text-[10px] px-2 py-0.5 rounded ${
                      filter === f
                        ? 'bg-[var(--color-accent)] text-black'
                        : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {f === 'all' ? '전체' : f === 'unread' ? '안 읽음' : '읽음'}
                  </button>
                ))}
              </div>
            </div>

            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-[var(--color-ink-muted)]">
                No notifications yet.
              </p>
            )}

            {running.length > 0 && (
              <Section title={`In progress (${running.length})`}>
                {running.map((it) => (
                  <NotificationRow
                    key={it.id}
                    item={it}
                    onClick={() => openItem(it)}
                    onDismiss={() => dismiss(it.id)}
                  />
                ))}
              </Section>
            )}

            {recent.length > 0 && (
              <Section
                title={
                  filter === 'all'
                    ? `Recent (${recent.length})`
                    : `Recent (${filteredRecent.length} / ${recent.length})`
                }
              >
                {filteredRecent.length === 0 ? (
                  <li className="px-3 py-4 text-center text-[10px] text-[var(--color-ink-muted)]">
                    No notifications match this filter.
                  </li>
                ) : (
                  <>
                    {visibleRecent.map((it) => (
                      <NotificationRow
                        key={it.id}
                        item={it}
                        onClick={() => openItem(it)}
                        onDismiss={() => dismiss(it.id)}
                      />
                    ))}
                    {hasMoreRecent && (
                      <li>
                        <div ref={sentinelRef} className="h-2" aria-hidden="true" />
                      </li>
                    )}
                  </>
                )}
              </Section>
            )}
          </div>
        )}
      </div>

      {selectedItem && (
        <NotificationDetail
          item={selectedItem}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]/70">
        {title}
      </div>
      <ul className="divide-y divide-[var(--color-border)]/40">{children}</ul>
    </div>
  );
}

function NotificationRow({
  item,
  onClick,
  onDismiss,
}: {
  item: NotificationItem;
  onClick: () => void;
  onDismiss: () => void;
}) {
  const ts = item.finishedAt ?? item.startedAt;
  // Visited-state styling is reserved for agent-turn notifications: those
  // are the ones whose read flag tracks "did the user actually look at
  // that agent's session". Other kinds collapse to read on bell open and
  // keep the original visual weight.
  const isAgent = item.kind === 'chat-done';
  const unread = isAgent && !item.read;
  return (
    <li className="group relative">
      {isAgent && (
        <span
          className={`absolute left-0 top-0 bottom-0 w-[2px] ${
            unread ? 'bg-[var(--color-accent)]' : 'bg-transparent'
          }`}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left px-3 py-2 hover:bg-[var(--color-surface-3)] flex items-start gap-2 ${
          isAgent ? 'pl-[14px]' : ''
        }`}
      >
        <div className="shrink-0 mt-0.5 text-[var(--color-ink-muted)]">
          {kindIcon(item.kind)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs">
            {statusIcon(item)}
            <span
              className={`truncate ${
                isAgent
                  ? unread
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'font-normal text-[var(--color-ink-muted)]'
                  : 'font-medium'
              }`}
            >
              {item.title}
            </span>
            {isAgent && (
              <span
                className={`shrink-0 text-[9px] leading-none px-1.5 py-[2px] rounded-full ${
                  unread
                    ? 'bg-[var(--color-accent)] text-black'
                    : 'border border-[var(--color-border)] text-[var(--color-ink-muted)]'
                }`}
                aria-label={unread ? 'unvisited' : 'visited'}
              >
                {unread ? '미확인' : '확인됨'}
              </span>
            )}
          </div>
          {(item.meta?.sessionTitle || item.meta?.projectName) && (
            <div className="text-[10px] text-[var(--color-ink-muted)] truncate">
              {item.meta?.projectName ?? item.meta?.sessionTitle}
            </div>
          )}
          <div className="text-[10px] text-[var(--color-ink-muted)]/70">
            {item.status === 'running' ? 'started' : ''} {formatRelative(ts)}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        title="Dismiss"
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400 p-0.5"
      >
        <X size={11} />
      </button>
    </li>
  );
}
