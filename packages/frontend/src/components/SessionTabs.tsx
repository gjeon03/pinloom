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
  onReorder: (sessions: Session[]) => void;
}

export function SessionTabs({
  projectId,
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onReorder,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; position: 'before' | 'after' } | null
  >(null);

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

  async function reorderTabs(sourceId: string, targetId: string, position: 'before' | 'after') {
    if (sourceId === targetId) return;
    const without = sessions.filter((s) => s.id !== sourceId);
    const targetNewIdx = without.findIndex((s) => s.id === targetId);
    if (targetNewIdx === -1) return;
    const insertAt = position === 'before' ? targetNewIdx : targetNewIdx + 1;
    const source = sessions.find((s) => s.id === sourceId);
    if (!source) return;

    const reordered = [...without];
    reordered.splice(insertAt, 0, source);
    onReorder(reordered);

    try {
      await api.reorderSessions(projectId, reordered.map((s) => s.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 overflow-x-auto"
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropTarget(null);
      }}
    >
      {sessions.map((s) => {
        const active = s.id === activeSessionId;
        const label = s.title ?? `Chat ${s.id.slice(0, 6)}`;
        const editing = editingId === s.id;
        const isDragging = draggingId === s.id;
        const showBefore =
          dropTarget?.id === s.id && dropTarget.position === 'before' && draggingId !== s.id;
        const showAfter =
          dropTarget?.id === s.id && dropTarget.position === 'after' && draggingId !== s.id;

        return (
          <div key={s.id} className="flex items-stretch">
            <div
              className={`w-0.5 self-stretch my-1.5 rounded-full transition-colors ${
                showBefore ? 'bg-[var(--color-accent)]' : 'bg-transparent'
              }`}
            />
            <div
              draggable={!editing}
              onDragStart={(e) => {
                if (editing) return;
                setDraggingId(s.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', s.id);
                const original = e.currentTarget;
                const ghost = original.cloneNode(true) as HTMLElement;
                ghost.style.position = 'absolute';
                ghost.style.top = '-9999px';
                ghost.style.left = '-9999px';
                ghost.style.opacity = '0.5';
                ghost.style.transform = 'scale(0.8)';
                ghost.style.pointerEvents = 'none';
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 20, 10);
                setTimeout(() => ghost.remove(), 0);
              }}
              onDragOver={(e) => {
                if (!draggingId || draggingId === s.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const position: 'before' | 'after' =
                  e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                if (dropTarget?.id !== s.id || dropTarget.position !== position) {
                  setDropTarget({ id: s.id, position });
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
                const position = dropTarget?.position ?? 'before';
                setDropTarget(null);
                setDraggingId(null);
                if (sourceId) void reorderTabs(sourceId, s.id, position);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTarget(null);
              }}
              className={`group flex items-center gap-1 rounded-t px-3 py-1.5 text-sm ${
                editing ? 'cursor-text' : 'cursor-pointer'
              } border-b-2 ${
                active
                  ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-2)]'
                  : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              } ${isDragging ? 'opacity-40' : ''}`}
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
                <span className="truncate max-w-[180px]">{label}</span>
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
            <div
              className={`w-0.5 self-stretch my-1.5 rounded-full transition-colors ${
                showAfter ? 'bg-[var(--color-accent)]' : 'bg-transparent'
              }`}
            />
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
