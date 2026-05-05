import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';
import type { Project, ProjectGroup } from '@pinloom/shared';
import { api } from '../api/client.js';
import { SettingsModal } from './SettingsModal.js';
import { DirectoryPicker } from './DirectoryPicker.js';
import { Tooltip } from './Tooltip.js';
import { useTheme } from '../hooks/useTheme.js';

const COLLAPSED_STORAGE_KEY = 'pinloom.groupCollapsed';

interface ShellHelpers {
  onProjectRenamed: (project: Project) => void;
}

interface Props {
  children: (project: Project | null, helpers: ShellHelpers) => React.ReactNode;
}

type DragSource =
  | { kind: 'project'; id: string }
  | { kind: 'group'; id: string }
  | null;

type DropTarget =
  | { kind: 'project'; id: string; position: 'before' | 'after' }
  | { kind: 'group-end'; groupId: string | null }
  | { kind: 'group-header'; id: string; position: 'before' | 'after' }
  | null;

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'project';
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}

function applyProjectMove(
  current: Project[],
  draggedId: string,
  newGroupId: string | null,
  // null = append to the new group's bucket
  insertBeforeId: string | null,
): Project[] {
  const dragged = current.find((p) => p.id === draggedId);
  if (!dragged) return current;
  const without = current.filter((p) => p.id !== draggedId);
  const updated = { ...dragged, groupId: newGroupId };

  if (insertBeforeId === null) {
    let lastIdx = -1;
    for (let i = 0; i < without.length; i++) {
      if ((without[i].groupId ?? null) === newGroupId) lastIdx = i;
    }
    return [...without.slice(0, lastIdx + 1), updated, ...without.slice(lastIdx + 1)];
  }

  const idx = without.findIndex((p) => p.id === insertBeforeId);
  if (idx === -1) return [...without, updated];
  return [...without.slice(0, idx), updated, ...without.slice(idx)];
}

function toProjectReorderItems(
  groups: ProjectGroup[],
  projects: Project[],
): Array<{ id: string; groupId: string | null }> {
  const items: Array<{ id: string; groupId: string | null }> = [];
  for (const g of groups) {
    for (const p of projects) {
      if ((p.groupId ?? null) === g.id) items.push({ id: p.id, groupId: g.id });
    }
  }
  for (const p of projects) {
    if (p.groupId === null) items.push({ id: p.id, groupId: null });
  }
  return items;
}

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const onWiki = location.pathname.startsWith('/wiki');

  const [projects, setProjects] = useState<Project[]>([]);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsed);
  const [picking, setPicking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragSource>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [openMenuGroupId, setOpenMenuGroupId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listProjects(), api.listProjectGroups()])
      .then(([ps, gs]) => {
        setProjects(ps);
        setGroups(gs);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_STORAGE_KEY,
        JSON.stringify([...collapsedGroups]),
      );
    } catch {
      // ignore quota / unavailability
    }
  }, [collapsedGroups]);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;

  const ungroupedProjects = useMemo(
    () => projects.filter((p) => p.groupId === null),
    [projects],
  );

  const showUngroupedSection = groups.length > 0;

  async function handleDirectoryChosen(cwd: string) {
    setError(null);
    try {
      const name = basenameOfPath(cwd);
      // Inherit the active project's group so creating-from-context is sticky.
      const inheritGroupId = activeProject?.groupId ?? null;
      const created = await api.createProject({ name, cwd, groupId: inheritGroupId });
      setProjects((prev) => [created, ...prev]);
      setPicking(false);
      navigate(`/projects/${created.id}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCreateGroup() {
    setError(null);
    const name = prompt('New group name')?.trim();
    if (!name) return;
    try {
      const created = await api.createProjectGroup(name);
      setGroups((prev) => [...prev, created]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRenameGroup(id: string, name: string) {
    setError(null);
    try {
      const updated = await api.renameProjectGroup(id, name);
      setGroups((prev) => prev.map((g) => (g.id === id ? updated : g)));
    } catch (e) {
      setError(String(e));
    } finally {
      setRenamingGroupId(null);
    }
  }

  async function handleDeleteGroup(id: string) {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    if (!window.confirm(`Delete group "${g.name}"? Projects inside will move to Ungrouped.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteProjectGroup(id);
      setGroups((prev) => prev.filter((x) => x.id !== id));
      // Member projects' group_id was set to NULL on the server; reflect locally.
      setProjects((prev) =>
        prev.map((p) => (p.groupId === id ? { ...p, groupId: null } : p)),
      );
      setCollapsedGroups((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setOpenMenuGroupId(null);
    }
  }

  function toggleCollapsed(id: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function commitProjectMove(
    draggedId: string,
    newGroupId: string | null,
    insertBeforeId: string | null,
  ) {
    const next = applyProjectMove(projects, draggedId, newGroupId, insertBeforeId);
    setProjects(next);
    // If dropping into a collapsed group, expand it so the user sees the result.
    if (newGroupId && collapsedGroups.has(newGroupId)) {
      setCollapsedGroups((prev) => {
        const n = new Set(prev);
        n.delete(newGroupId);
        return n;
      });
    }
    try {
      await api.reorderProjects(toProjectReorderItems(groups, next));
    } catch (e) {
      setError(String(e));
      const fresh = await api.listProjects();
      setProjects(fresh);
    }
  }

  async function commitGroupMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after',
  ) {
    if (draggedId === targetId) return;
    const dragged = groups.find((g) => g.id === draggedId);
    if (!dragged) return;
    const without = groups.filter((g) => g.id !== draggedId);
    const targetIdx = without.findIndex((g) => g.id === targetId);
    if (targetIdx === -1) return;
    const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
    const reordered = [...without];
    reordered.splice(insertAt, 0, dragged);

    setGroups(reordered);
    try {
      await api.reorderProjectGroups(reordered.map((g) => g.id));
    } catch (e) {
      setError(String(e));
      const fresh = await api.listProjectGroups();
      setGroups(fresh);
    }
  }

  function resetDrag() {
    setDrag(null);
    setDropTarget(null);
  }

  function commitDrop() {
    const source = drag;
    const target = dropTarget;
    resetDrag();
    if (!source || !target) return;

    if (source.kind === 'project') {
      if (target.kind === 'project') {
        const targetProj = projects.find((p) => p.id === target.id);
        if (!targetProj) return;
        const newGroupId = targetProj.groupId ?? null;
        let insertBeforeId: string | null;
        if (target.position === 'before') {
          insertBeforeId = targetProj.id;
        } else {
          const sameBucket = projects.filter(
            (p) => (p.groupId ?? null) === newGroupId,
          );
          const idx = sameBucket.findIndex((p) => p.id === targetProj.id);
          const next = sameBucket[idx + 1];
          insertBeforeId =
            next && next.id !== source.id ? next.id : null;
        }
        if (insertBeforeId === source.id) return;
        void commitProjectMove(source.id, newGroupId, insertBeforeId);
      } else if (target.kind === 'group-end') {
        void commitProjectMove(source.id, target.groupId, null);
      }
    } else if (source.kind === 'group') {
      if (target.kind === 'group-header' && target.id !== source.id) {
        void commitGroupMove(source.id, target.id, target.position);
      }
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
        <div className="px-3 py-3 flex items-center justify-between gap-1">
          <div className="text-sm font-semibold tracking-wide truncate">pinloom</div>
          <div className="flex items-center gap-0.5">
            <Tooltip label="New group" side="bottom">
              <button
                onClick={handleCreateGroup}
                className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
              >
                <FolderPlus size={14} />
              </button>
            </Tooltip>
            <Tooltip label="New project — pick a directory" side="bottom">
              <button
                onClick={() => setPicking(true)}
                className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
              >
                <Plus size={16} />
              </button>
            </Tooltip>
          </div>
        </div>

        {error && (
          <p className="px-3 pb-2 text-[11px] text-red-400 border-b border-[var(--color-border)]">
            {error}
          </p>
        )}

        <div
          className="flex-1 overflow-auto py-2 flex flex-col"
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            commitDrop();
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropTarget(null);
          }}
        >
          {groups.map((g) => {
            const items = projects.filter((p) => p.groupId === g.id);
            const collapsed = collapsedGroups.has(g.id);
            const showHeaderBefore =
              dropTarget?.kind === 'group-header' &&
              dropTarget.id === g.id &&
              dropTarget.position === 'before' &&
              drag?.kind === 'group' &&
              drag.id !== g.id;
            const showHeaderHighlight =
              dropTarget?.kind === 'group-end' &&
              dropTarget.groupId === g.id &&
              drag?.kind === 'project';

            return (
              <div key={g.id} className="flex flex-col">
                <div
                  className={`mx-2 h-0.5 rounded-full transition-colors ${
                    showHeaderBefore ? 'bg-[var(--color-accent)]' : 'bg-transparent'
                  }`}
                />
                <GroupHeader
                  group={g}
                  collapsed={collapsed}
                  highlighted={showHeaderHighlight}
                  isDragging={drag?.kind === 'group' && drag.id === g.id}
                  isRenaming={renamingGroupId === g.id}
                  menuOpen={openMenuGroupId === g.id}
                  onToggleCollapsed={() => toggleCollapsed(g.id)}
                  onMenuOpen={() => setOpenMenuGroupId(g.id)}
                  onMenuClose={() => setOpenMenuGroupId(null)}
                  onStartRename={() => {
                    setOpenMenuGroupId(null);
                    setRenamingGroupId(g.id);
                  }}
                  onCommitRename={(name) => handleRenameGroup(g.id, name)}
                  onCancelRename={() => setRenamingGroupId(null)}
                  onDelete={() => handleDeleteGroup(g.id)}
                  onDragStart={(e) => {
                    setDrag({ kind: 'group', id: g.id });
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', `group:${g.id}`);
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (drag.kind === 'project') {
                      setDropTarget({ kind: 'group-end', groupId: g.id });
                    } else if (drag.kind === 'group' && drag.id !== g.id) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const isTopHalf = e.clientY < rect.top + rect.height / 2;
                      setDropTarget({
                        kind: 'group-header',
                        id: g.id,
                        position: isTopHalf ? 'before' : 'after',
                      });
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    commitDrop();
                  }}
                  onDragEnd={resetDrag}
                />
                {!collapsed && (
                  <ProjectsList
                    projects={items}
                    activeProjectId={projectId ?? null}
                    drag={drag}
                    dropTarget={dropTarget}
                    onNavigate={(id) => navigate(`/projects/${id}`)}
                    onProjectDragStart={(id) => setDrag({ kind: 'project', id })}
                    onProjectDragOver={(targetId, position) =>
                      setDropTarget({ kind: 'project', id: targetId, position })
                    }
                    onDragEnd={resetDrag}
                    onDrop={commitDrop}
                  />
                )}
              </div>
            );
          })}

          {/* Drop indicator before the (virtual) end-of-groups slot */}
          {(() => {
            const lastGroup = groups[groups.length - 1];
            const showAfterLast =
              !!lastGroup &&
              dropTarget?.kind === 'group-header' &&
              dropTarget.id === lastGroup.id &&
              dropTarget.position === 'after' &&
              drag?.kind === 'group' &&
              drag.id !== lastGroup.id;
            return (
              <div
                className={`mx-2 h-0.5 rounded-full transition-colors ${
                  showAfterLast ? 'bg-[var(--color-accent)]' : 'bg-transparent'
                }`}
              />
            );
          })()}

          {/* Ungrouped section. With no groups defined, render flat (no header). */}
          {groups.length === 0 ? (
            <ProjectsList
              projects={ungroupedProjects}
              activeProjectId={projectId ?? null}
              drag={drag}
              dropTarget={dropTarget}
              onNavigate={(id) => navigate(`/projects/${id}`)}
              onProjectDragStart={(id) => setDrag({ kind: 'project', id })}
              onProjectDragOver={(targetId, position) =>
                setDropTarget({ kind: 'project', id: targetId, position })
              }
              onDragEnd={resetDrag}
              onDrop={commitDrop}
            />
          ) : showUngroupedSection ? (
            <div className="flex flex-col">
              <div
                className={`mx-3 mt-3 mb-1 px-1 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)] rounded ${
                  dropTarget?.kind === 'group-end' &&
                  dropTarget.groupId === null &&
                  drag?.kind === 'project'
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-accent)]'
                    : ''
                }`}
                onDragOver={(e) => {
                  if (drag?.kind !== 'project') return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropTarget({ kind: 'group-end', groupId: null });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDrop();
                }}
              >
                Ungrouped
              </div>
              <ProjectsList
                projects={ungroupedProjects}
                activeProjectId={projectId ?? null}
                drag={drag}
                dropTarget={dropTarget}
                onNavigate={(id) => navigate(`/projects/${id}`)}
                onProjectDragStart={(id) => setDrag({ kind: 'project', id })}
                onProjectDragOver={(targetId, position) =>
                  setDropTarget({ kind: 'project', id: targetId, position })
                }
                onDragEnd={resetDrag}
                onDrop={commitDrop}
              />
              {ungroupedProjects.length === 0 && (
                <div
                  className={`mx-2 h-6 rounded transition-colors ${
                    dropTarget?.kind === 'group-end' &&
                    dropTarget.groupId === null &&
                    drag?.kind === 'project'
                      ? 'bg-[var(--color-surface-3)]'
                      : ''
                  }`}
                  onDragOver={(e) => {
                    if (drag?.kind !== 'project') return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTarget({ kind: 'group-end', groupId: null });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    commitDrop();
                  }}
                />
              )}
            </div>
          ) : null}

          {projects.length === 0 && groups.length === 0 && (
            <p className="px-3 text-xs text-[var(--color-ink-muted)]">
              Click + to pick a directory for your first project.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] p-2 space-y-1">
          <button
            onClick={() => navigate('/wiki')}
            className={`w-full rounded px-2 py-1.5 text-left text-xs flex items-center gap-1.5 ${
              onWiki
                ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
            }`}
          >
            <BookOpen size={12} />
            Wiki
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(true)}
              className="flex-1 rounded px-2 py-1.5 text-left text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] flex items-center gap-1.5"
            >
              <Settings size={12} />
              Settings
            </button>
            <ThemeToggle />
          </div>
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

interface GroupHeaderProps {
  group: ProjectGroup;
  collapsed: boolean;
  highlighted: boolean;
  isDragging: boolean;
  isRenaming: boolean;
  menuOpen: boolean;
  onToggleCollapsed: () => void;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function GroupHeader({
  group,
  collapsed,
  highlighted,
  isDragging,
  isRenaming,
  menuOpen,
  onToggleCollapsed,
  onMenuOpen,
  onMenuClose,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: GroupHeaderProps) {
  const Icon = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      draggable={!isRenaming}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`mx-2 my-0.5 rounded px-2 py-1 flex items-center gap-1 text-[11px] uppercase tracking-wider transition-colors ${
        highlighted
          ? 'bg-[var(--color-surface-3)] text-[var(--color-accent)]'
          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]/60'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="hover:text-[var(--color-accent)]"
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <Icon size={12} />
      </button>
      {isRenaming ? (
        <RenameInput
          initial={group.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex-1 text-left truncate font-semibold"
        >
          {group.name}
        </button>
      )}
      {!isRenaming && (
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) onMenuClose();
              else onMenuOpen();
            }}
            className="p-0.5 rounded hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
            title="Group options"
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <GroupMenu
              onRename={onStartRename}
              onDelete={onDelete}
              onClose={onMenuClose}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface RenameInputProps {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  function commit() {
    const next = draft.trim();
    if (next && next !== initial) onCommit(next);
    else onCancel();
  }
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1 py-0 text-[11px] uppercase tracking-wider outline-none focus:border-[var(--color-accent)]"
    />
  );
}

interface GroupMenuProps {
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function GroupMenu({ onRename, onDelete, onClose }: GroupMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-10 min-w-[100px] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg py-1 text-xs normal-case tracking-normal"
    >
      <button
        type="button"
        className="w-full text-left px-2 py-1 hover:bg-[var(--color-surface-3)]"
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
      >
        Rename
      </button>
      <button
        type="button"
        className="w-full text-left px-2 py-1 hover:bg-[var(--color-surface-3)] text-red-400"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        Delete
      </button>
    </div>
  );
}

interface ProjectsListProps {
  projects: Project[];
  activeProjectId: string | null;
  drag: DragSource;
  dropTarget: DropTarget;
  onNavigate: (id: string) => void;
  onProjectDragStart: (id: string) => void;
  onProjectDragOver: (
    targetId: string,
    position: 'before' | 'after',
  ) => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

function ProjectsList({
  projects,
  activeProjectId,
  drag,
  dropTarget,
  onNavigate,
  onProjectDragStart,
  onProjectDragOver,
  onDragEnd,
  onDrop,
}: ProjectsListProps) {
  return (
    <>
      {projects.map((p, i) => {
        const active = p.id === activeProjectId;
        const isDragging = drag?.kind === 'project' && drag.id === p.id;
        const showBefore =
          dropTarget?.kind === 'project' &&
          dropTarget.id === p.id &&
          dropTarget.position === 'before' &&
          drag?.kind === 'project' &&
          drag.id !== p.id;

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
                onProjectDragStart(p.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', `project:${p.id}`);
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
                if (drag?.kind !== 'project' || drag.id === p.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const isTopHalf = e.clientY < rect.top + rect.height / 2;
                if (isTopHalf) {
                  onProjectDragOver(p.id, 'before');
                } else {
                  const nextProj = projects[i + 1];
                  if (nextProj && nextProj.id !== drag.id) {
                    onProjectDragOver(nextProj.id, 'before');
                  } else {
                    onProjectDragOver(p.id, 'after');
                  }
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDrop();
              }}
              onDragEnd={onDragEnd}
              onClick={() => onNavigate(p.id)}
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
          dropTarget?.kind === 'project' &&
          dropTarget.id === lastId &&
          dropTarget.position === 'after' &&
          drag?.kind === 'project' &&
          drag.id !== lastId;
        return (
          <div
            className={`mx-2 h-0.5 rounded-full transition-colors ${
              showTail ? 'bg-[var(--color-accent)]' : 'bg-transparent'
            }`}
          />
        );
      })()}
    </>
  );
}

function ThemeToggle() {
  const { preference, effective, setPreference } = useTheme();
  const next: typeof preference =
    preference === 'system'
      ? effective === 'dark'
        ? 'light'
        : 'dark'
      : preference === 'dark'
        ? 'light'
        : 'system';
  const label =
    preference === 'system'
      ? `Theme: System (${effective}) — click for ${next}`
      : preference === 'dark'
        ? 'Theme: Dark — click for Light'
        : 'Theme: Light — click for System';
  const Icon = preference === 'system' ? Monitor : effective === 'dark' ? Moon : Sun;
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={() => setPreference(next)}
        className="rounded p-1.5 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
      >
        <Icon size={12} />
      </button>
    </Tooltip>
  );
}
