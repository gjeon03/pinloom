import { useState } from 'react';
import { ExternalLink, Plus, X } from 'lucide-react';
import type { Session } from '@pinloom/shared';
import { api } from '../api/client.js';

interface Props {
  projectId: string;
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (session: Session) => void;
  onCreate: (session: Session) => void;
  onDelete: (sessionId: string) => void;
  onRename: (session: Session) => void;
}

export function SessionTabs({
  projectId,
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canDelete = sessions.length > 1;

  async function createTab() {
    try {
      const created = await api.createSession(projectId, {
        title: 'New chat',
      });
      onCreate(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveRename(session: Session) {
    const next = editValue.trim() || null;
    try {
      const updated = await api.renameSession(session.id, next);
      onRename(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditingId(null);
    }
  }

  async function deleteTab(session: Session) {
    if (!canDelete) return;
    if (!confirm(`Delete "${session.title ?? 'untitled'}"? This cannot be undone.`)) return;
    try {
      await api.deleteSession(session.id);
      onDelete(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 overflow-x-auto">
      {sessions.map((s) => {
        const active = s.id === activeSessionId;
        const label = s.title ?? `Chat ${s.id.slice(0, 6)}`;
        const editing = editingId === s.id;
        return (
          <div
            key={s.id}
            className={`group flex items-center gap-1 rounded-t px-3 py-1.5 text-sm ${editing ? 'cursor-text' : 'cursor-pointer'} border-b-2 ${
              active
                ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-2)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
            }`}
            onClick={() => !editing && onSelect(s)}
            onDoubleClick={() => {
              setEditingId(s.id);
              setEditValue(s.title ?? '');
            }}
          >
            {editing ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => saveRename(s)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename(s);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1 text-sm w-32"
              />
            ) : (
              <>
                <span className="truncate max-w-[180px]">{label}</span>
                {s.hasPendingContext && (
                  <span
                    title="Pinned context queued for the next message"
                    className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]"
                  />
                )}
              </>
            )}
            <a
              href={`/s/${s.id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open session in new tab"
              className={`p-0.5 rounded transition-opacity ${
                active
                  ? 'text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
                  : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
              }`}
            >
              <ExternalLink size={12} />
            </a>
            {canDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTab(s);
                }}
                className={`p-0.5 rounded transition-opacity ${
                  active
                    ? 'text-[var(--color-ink-muted)] hover:text-red-400'
                    : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400'
                }`}
                title="Delete tab"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={createTab}
        className="ml-1 p-1.5 rounded text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
        title="New tab"
      >
        <Plus size={14} />
      </button>
      {error && (
        <span className="ml-2 text-xs text-red-400 truncate max-w-[200px]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
