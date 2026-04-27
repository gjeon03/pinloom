import { useEffect } from 'react';
import { Check, CircleAlert, Loader2, X } from 'lucide-react';
import type { NotificationItem } from '../stores/notifications.js';

interface Props {
  item: NotificationItem;
  onClose: () => void;
}

export function NotificationDetail({ item, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusLabel =
    item.status === 'running' ? 'In progress' : item.status === 'success' ? 'Completed' : 'Failed';
  const statusIcon =
    item.status === 'running' ? (
      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
    ) : item.status === 'success' ? (
      <Check size={14} className="text-emerald-400" />
    ) : (
      <CircleAlert size={14} className="text-red-400" />
    );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-2">
          {statusIcon}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{item.title}</div>
            {item.meta?.sessionTitle && (
              <div className="text-[11px] text-[var(--color-ink-muted)] truncate">
                {item.meta.sessionTitle}
              </div>
            )}
          </div>
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-auto p-4 text-sm">
          {item.detail ? (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-[var(--color-ink)]/90">
              {item.detail}
            </pre>
          ) : (
            <p className="text-[var(--color-ink-muted)] italic">
              {item.status === 'running'
                ? 'Still running…'
                : 'No additional detail.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
