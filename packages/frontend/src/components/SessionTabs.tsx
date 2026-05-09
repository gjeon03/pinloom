import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Crown,
  ExternalLink,
  MoreVertical,
  Network,
  Plus,
  X,
} from 'lucide-react';
import type { AgentKind, Session, Team } from '@pinloom/shared';
import { api } from '../api/client.js';
import { AgentBadge } from './AgentBadge.js';
import { Tooltip } from './Tooltip.js';

type TeamRole =
  | { kind: 'orchestrator'; teamId: string; teamName: string }
  | { kind: 'worker'; teamId: string; teamName: string; alias: string };

function buildTeamRoles(teams: Team[]): Map<string, TeamRole> {
  const map = new Map<string, TeamRole>();
  for (const team of teams) {
    map.set(team.orchestratorSessionId, {
      kind: 'orchestrator',
      teamId: team.id,
      teamName: team.name,
    });
    for (const m of team.members) {
      map.set(m.sessionId, {
        kind: 'worker',
        teamId: team.id,
        teamName: team.name,
        alias: m.alias,
      });
    }
  }
  return map;
}

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCoords, setPickerCoords] = useState<{ top: number; right: number } | null>(null);
  const [codexAvailable, setCodexAvailable] = useState<boolean | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  // Per-tab actions dropdown ("open chat" / "open canvas" / future
  // session-config). Only one tab can have its menu open at a time.
  const [tabMenu, setTabMenu] = useState<{
    sessionId: string;
    top: number;
    left: number;
  } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);

  // Team membership lookup so we can render "@alias" / "orchestrator"
  // badges next to tab titles. Refetched whenever the user creates or
  // changes a team via the same window event the AppShell sidebar uses.
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    let cancelled = false;
    function reload() {
      api
        .listTeams()
        .then((t) => {
          if (!cancelled) setTeams(t);
        })
        .catch(() => {
          if (!cancelled) setTeams([]);
        });
    }
    reload();
    function onTeamsChanged() {
      reload();
    }
    window.addEventListener('pinloom:teams-changed', onTeamsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('pinloom:teams-changed', onTeamsChanged);
    };
  }, []);
  const rolesBySessionId = useMemo(() => buildTeamRoles(teams), [teams]);

  // One-shot health probe to know whether the Codex CLI is on PATH.
  // We use this only to dim the picker option — even when codex looks
  // unavailable the user can still try (the backend will report a clear
  // spawn error if so).
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

  // Click-outside dismiss for the picker dropdown.
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  // Click-outside dismiss for the per-tab actions menu.
  useEffect(() => {
    if (!tabMenu) return;
    function onClick(e: MouseEvent) {
      if (
        tabMenuRef.current &&
        !tabMenuRef.current.contains(e.target as Node) &&
        !(e.target as Element).closest('[data-tab-menu-trigger]')
      ) {
        setTabMenu(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [tabMenu]);

  const canDelete = sessions.length > 1;

  async function createTab(agent: AgentKind) {
    setPickerOpen(false);
    try {
      // Leave the title null so the tab renders as "Chat <6char-suffix>"
      // (see fallback below). Same default as the inline-creation flow
      // in the Teams page — keeps suffixes unique across many "new"
      // sessions instead of stacking identical "New chat" labels.
      const created = await api.createSession(projectId, {
        title: null,
        agent,
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
      onDragOver={(e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
        const target = dropTarget;
        setDropTarget(null);
        setDraggingId(null);
        if (!sourceId) return;
        if (target) {
          void reorderTabs(sourceId, target.id, target.position);
        } else {
          const last = sessions[sessions.length - 1];
          if (last && last.id !== sourceId) {
            void reorderTabs(sourceId, last.id, 'after');
          }
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropTarget(null);
      }}
    >
      {sessions.map((s, i) => {
        const active = s.id === activeSessionId;
        const label = s.title ?? `Chat ${s.id.slice(0, 6)}`;
        const editing = editingId === s.id;
        const isDragging = draggingId === s.id;
        const showBefore =
          dropTarget?.id === s.id && dropTarget.position === 'before' && draggingId !== s.id;

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
                ghost.style.opacity = '0.25';
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
                const isLeftHalf = e.clientX < rect.left + rect.width / 2;
                let next: { id: string; position: 'before' | 'after' };
                if (isLeftHalf) {
                  next = { id: s.id, position: 'before' };
                } else {
                  const nextTab = sessions[i + 1];
                  if (nextTab && nextTab.id !== draggingId) {
                    next = { id: nextTab.id, position: 'before' };
                  } else {
                    next = { id: s.id, position: 'after' };
                  }
                }
                if (dropTarget?.id !== next.id || dropTarget.position !== next.position) {
                  setDropTarget(next);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
                const targetId = dropTarget?.id ?? s.id;
                const position = dropTarget?.position ?? 'before';
                setDropTarget(null);
                setDraggingId(null);
                if (sourceId) void reorderTabs(sourceId, targetId, position);
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
              <AgentBadge agent={s.agent} size="xs" />
              <TeamRoleBadge role={rolesBySessionId.get(s.id) ?? null} />
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
              <button
                type="button"
                data-tab-menu-trigger
                onClick={(e) => {
                  e.stopPropagation();
                  if (tabMenu?.sessionId === s.id) {
                    setTabMenu(null);
                    return;
                  }
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setTabMenu({
                    sessionId: s.id,
                    top: r.bottom + 4,
                    left: r.left,
                  });
                }}
                title="Tab actions"
                className={`p-0.5 rounded transition-opacity ${
                  active
                    ? 'text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
                    : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
                }`}
              >
                <MoreVertical size={12} />
              </button>
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
          </div>
        );
      })}
      {(() => {
        const lastId = sessions[sessions.length - 1]?.id;
        const showTail =
          !!lastId &&
          dropTarget?.id === lastId &&
          dropTarget?.position === 'after' &&
          draggingId !== lastId;
        return (
          <div
            className={`w-0.5 self-stretch my-1.5 rounded-full transition-colors ${
              showTail ? 'bg-[var(--color-accent)]' : 'bg-transparent'
            }`}
          />
        );
      })()}
      <div ref={pickerRef} className="relative ml-1 shrink-0">
        <button
          ref={pickerButtonRef}
          type="button"
          onClick={() => {
            // The tab bar uses overflow-x-auto, which (per CSS spec) implicitly
            // clips overflow-y too. So we render the dropdown with position:fixed
            // anchored to the button's screen rect to escape the clip.
            const r = pickerButtonRef.current?.getBoundingClientRect();
            if (r) {
              setPickerCoords({
                top: r.bottom + 4,
                right: Math.max(0, window.innerWidth - r.right),
              });
            }
            setPickerOpen((v) => !v);
          }}
          className="flex items-center gap-0.5 p-1.5 rounded text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
          title="New tab — pick agent"
        >
          <Plus size={14} />
          <ChevronDown size={10} />
        </button>
        {pickerOpen && pickerCoords && (
          <div
            style={{
              position: 'fixed',
              top: pickerCoords.top,
              right: pickerCoords.right,
              zIndex: 50,
            }}
            className="min-w-[140px] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg py-1 text-xs"
          >
            <button
              type="button"
              onClick={() => createTab('claude')}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-3)] text-left"
            >
              <AgentBadge agent="claude" />
              <span className="flex-1">Claude</span>
            </button>
            <button
              type="button"
              onClick={() => createTab('codex')}
              disabled={codexAvailable === false}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-3)] text-left disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                codexAvailable === false
                  ? 'Codex CLI not detected on PATH — install or run `codex login`'
                  : 'New Codex session'
              }
            >
              <AgentBadge agent="codex" />
              <span className="flex-1">Codex</span>
              {codexAvailable === false && (
                <span className="text-[9px] text-[var(--color-ink-muted)]">N/A</span>
              )}
            </button>
          </div>
        )}
      </div>
      {error && (
        <span className="ml-2 text-xs text-red-400 truncate max-w-[200px]" title={error}>
          {error}
        </span>
      )}
      {tabMenu &&
        (() => {
          const role = rolesBySessionId.get(tabMenu.sessionId) ?? null;
          return (
            <div
              ref={tabMenuRef}
              style={{
                position: 'fixed',
                top: tabMenu.top,
                left: tabMenu.left,
                zIndex: 50,
              }}
              className="min-w-[180px] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg py-1 text-xs"
            >
              <a
                href={`/s/${tabMenu.sessionId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setTabMenu(null)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-[var(--color-ink)]"
              >
                <ExternalLink size={12} />
                <span className="flex-1">Open chat in new tab</span>
              </a>
              {role?.kind === 'orchestrator' && (
                <a
                  href={`/teams/${role.teamId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setTabMenu(null)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                >
                  <Network size={12} />
                  <span className="flex-1">Open team canvas</span>
                </a>
              )}
            </div>
          );
        })()}
    </div>
  );
}

// Surfaces a session's role inside a team. Orchestrator gets a crown
// icon; workers get a "@alias" pill. The native title attribute carries
// the team name so the user can hover for full context without the
// badge eating tab width.
function TeamRoleBadge({ role }: { role: TeamRole | null }) {
  if (!role) return null;
  if (role.kind === 'orchestrator') {
    return (
      <Tooltip label={`Orchestrator of team "${role.teamName}"`} side="top">
        <span className="inline-flex items-center text-[var(--color-accent)]">
          <Crown size={12} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={`@${role.alias} in team "${role.teamName}"`} side="top">
      <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-[1px] text-[10px] font-mono text-[var(--color-ink-muted)]">
        @{role.alias}
      </span>
    </Tooltip>
  );
}
