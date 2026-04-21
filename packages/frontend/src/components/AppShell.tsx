import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Settings } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api } from '../api/client.js';
import { SettingsModal } from './SettingsModal.js';
import { DirectoryPicker } from './DirectoryPicker.js';

interface ShellHelpers {
  onProjectRenamed: (project: Project) => void;
}

interface Props {
  children: (project: Project | null, helpers: ShellHelpers) => React.ReactNode;
}

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'project';
}

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [picking, setPicking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; position: 'before' | 'after' } | null
  >(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;

  async function handleDirectoryChosen(cwd: string) {
    setError(null);
    try {
      const name = basenameOfPath(cwd);
      const created = await api.createProject({ name, cwd });
      setProjects((prev) => [created, ...prev]);
      setPicking(false);
      navigate(`/projects/${created.id}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function reorderProjects(
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) {
    if (sourceId === targetId) return;

    const without = projects.filter((p) => p.id !== sourceId);
    const targetNewIdx = without.findIndex((p) => p.id === targetId);
    if (targetNewIdx === -1) return;

    const insertAt = position === 'before' ? targetNewIdx : targetNewIdx + 1;
    const source = projects.find((p) => p.id === sourceId);
    if (!source) return;

    const reordered = [...without];
    reordered.splice(insertAt, 0, source);

    setProjects(reordered);
    try {
      await api.reorderProjects(reordered.map((p) => p.id));
    } catch (e) {
      setError(String(e));
      const fresh = await api.listProjects();
      setProjects(fresh);
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
        <div className="px-3 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold tracking-wide">pinloom</div>
          <button
            onClick={() => setPicking(true)}
            title="New project — pick a directory"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <Plus size={16} />
          </button>
        </div>

        {error && (
          <p className="px-3 pb-2 text-[11px] text-red-400 border-b border-[var(--color-border)]">
            {error}
          </p>
        )}

        <div
          className="flex-1 overflow-auto py-2 flex flex-col"
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropTarget(null);
          }}
        >
          {projects.map((p, i) => {
            const active = p.id === projectId;
            const isDragging = draggingId === p.id;
            const showBefore =
              dropTarget?.id === p.id &&
              dropTarget.position === 'before' &&
              draggingId !== p.id;

            return (
              <div key={p.id} className="flex flex-col">
                <div
                  className={`mx-2 h-0.5 rounded-full transition-colors ${
                    showBefore ? 'bg-[var(--color-accent)]' : 'bg-transparent'
                  }`}
                />
                <button
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(p.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', p.id);
                    const original = e.currentTarget;
                    const ghost = original.cloneNode(true) as HTMLElement;
                    ghost.style.position = 'absolute';
                    ghost.style.top = '-9999px';
                    ghost.style.left = '-9999px';
                    ghost.style.opacity = '0.25';
                    ghost.style.transform = 'scale(0.85)';
                    ghost.style.pointerEvents = 'none';
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(ghost, 20, 10);
                    setTimeout(() => ghost.remove(), 0);
                  }}
                  onDragOver={(e) => {
                    if (!draggingId || draggingId === p.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = e.currentTarget.getBoundingClientRect();
                    const isTopHalf = e.clientY < rect.top + rect.height / 2;
                    let next: { id: string; position: 'before' | 'after' };
                    if (isTopHalf) {
                      next = { id: p.id, position: 'before' };
                    } else {
                      const nextProj = projects[i + 1];
                      if (nextProj && nextProj.id !== draggingId) {
                        next = { id: nextProj.id, position: 'before' };
                      } else {
                        next = { id: p.id, position: 'after' };
                      }
                    }
                    if (
                      dropTarget?.id !== next.id ||
                      dropTarget.position !== next.position
                    ) {
                      setDropTarget(next);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
                    const targetId = dropTarget?.id ?? p.id;
                    const position = dropTarget?.position ?? 'before';
                    setDropTarget(null);
                    setDraggingId(null);
                    if (sourceId) void reorderProjects(sourceId, targetId, position);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTarget(null);
                  }}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className={`mx-2 my-0.5 rounded px-2 py-1.5 text-left text-sm flex flex-col gap-0.5 transition-colors ${
                    active
                      ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                      : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]/60'
                  } ${isDragging ? 'opacity-40' : ''}`}
                >
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="truncate text-[10px] opacity-70 font-mono">{p.cwd}</span>
                </button>
              </div>
            );
          })}
          {(() => {
            const lastId = projects[projects.length - 1]?.id;
            const showTail =
              !!lastId &&
              dropTarget?.id === lastId &&
              dropTarget?.position === 'after' &&
              draggingId !== lastId;
            return (
              <div
                className={`mx-2 h-0.5 rounded-full transition-colors ${
                  showTail ? 'bg-[var(--color-accent)]' : 'bg-transparent'
                }`}
              />
            );
          })()}
          {projects.length === 0 && (
            <p className="px-3 text-xs text-[var(--color-ink-muted)]">
              Click + to pick a directory for your first project.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] p-2">
          <button
            onClick={() => setShowSettings(true)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] flex items-center gap-1.5"
          >
            <Settings size={12} />
            Settings
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        {children(activeProject, {
          onProjectRenamed: (updated) => {
            setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          },
        })}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {picking && (
        <DirectoryPicker
          onSelect={handleDirectoryChosen}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
