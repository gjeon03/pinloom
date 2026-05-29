import { useEffect, useRef, useState } from 'react';
import { Bell, BookPlus, Check, CircleAlert, Loader2, Sparkles, X } from 'lucide-react';
import {
  useNotifications,
  type NotificationItem,
  type NotificationKind,
} from '../stores/notifications.js';
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
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  const showBadge = runningCount > 0 || unreadCount > 0;
  const badgeCount = runningCount + unreadCount;
  const selectedItem = selectedId ? items.find((it) => it.id === selectedId) ?? null : null;

  function toggleOpen() {
    setOpen((v) => {
      const next = !v;
      if (next) markAllRead();
      return next;
    });
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
          <div className="absolute top-full right-0 mt-2 w-80 max-h-[70vh] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl">
            <header className="sticky top-0 bg-[var(--color-surface-2)]/95 backdrop-blur-sm border-b border-[var(--color-border)] px-3 py-2 flex items-center justify-between">
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
                    onClick={() => {
                      setSelectedId(it.id);
                      setOpen(false);
                      markRead(it.id);
                    }}
                    onDismiss={() => dismiss(it.id)}
                  />
                ))}
              </Section>
            )}

            {recent.length > 0 && (
              <Section title={`Recent (${recent.length})`}>
                {recent.map((it) => (
                  <NotificationRow
                    key={it.id}
                    item={it}
                    onClick={() => {
                      setSelectedId(it.id);
                      setOpen(false);
                      markRead(it.id);
                    }}
                    onDismiss={() => dismiss(it.id)}
                  />
                ))}
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
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-3)] flex items-start gap-2"
      >
        <div className="shrink-0 mt-0.5 text-[var(--color-ink-muted)]">
          {kindIcon(item.kind)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs">
            {statusIcon(item)}
            <span className="font-medium truncate">{item.title}</span>
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
