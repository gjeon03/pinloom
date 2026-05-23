import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  Crown,
  ExternalLink,
  FolderInput,
  ListChecks,
  MoreVertical,
  Network,
  Pencil,
  Plus,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { AgentKind, Project, Session, Team } from '@pinloom/shared';
import { api } from '../api/client.js';
import { AgentBadge } from './AgentBadge.js';
import { Tooltip } from './Tooltip.js';

type TeamRole =
  | { kind: 'orchestrator'; teamId: string; teamName: string }
  | {
      kind: 'worker';
      teamId: string;
      teamName: string;
      alias: string;
      instructions: string | null;
      tags: string[];
    };

// Splits a comma-separated tags input into a clean array. Trims, drops
// empties, dedupes — server-side validation still applies pattern rules
// (lowercase, alnum + - / _) so a bad token surfaces an error there.
function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

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
        instructions: m.instructions,
        tags: m.tags,
      });
    }
  }
  return map;
}

export interface InlineCanvasTab {
  teamId: string;
  teamName: string;
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
  /** Inline canvas pseudo-tabs the user has opened next to the chats. */
  canvasTabs?: InlineCanvasTab[];
  activeCanvasTeamId?: string | null;
  onSelectCanvas?: (teamId: string) => void;
  onCloseCanvas?: (teamId: string) => void;
  onOpenCanvasTab?: (tab: InlineCanvasTab) => void;
  /** Project-scoped plan pseudo-tab. There's exactly one per project. */
  planActive?: boolean;
  onSelectPlan?: () => void;
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
  canvasTabs = [],
  activeCanvasTeamId = null,
  onSelectCanvas,
  onCloseCanvas,
  onOpenCanvasTab,
  planActive = false,
  onSelectPlan,
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
  const [moveModal, setMoveModal] = useState<{ sessionId: string } | null>(
    null,
  );
  const [createTeamModal, setCreateTeamModal] = useState<{
    sessionId: string;
    sessionTitle: string;
  } | null>(null);
  const [addWorkerModal, setAddWorkerModal] = useState<{
    teamId: string;
    teamName: string;
  } | null>(null);
  const [editWorkerModal, setEditWorkerModal] = useState<{
    teamId: string;
    teamName: string;
    sessionId: string;
    alias: string;
    instructions: string | null;
    tags: string[];
  } | null>(null);
  const navigate = useNavigate();

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
      {onSelectPlan && (
        <button
          type="button"
          onClick={onSelectPlan}
          className={`group flex items-center gap-1.5 rounded-t px-3 py-1.5 text-sm cursor-pointer border-b-2 mr-1 ${
            planActive
              ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-2)]'
              : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          }`}
          title="Project plan — hierarchical to-do tree the AI reads on every turn"
        >
          <ListChecks size={12} className="text-[var(--color-accent)] shrink-0" />
          <span>Plan</span>
        </button>
      )}
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
            </div>
          </div>
        );
      })}
      {canvasTabs.map((c) => {
        const active = c.teamId === activeCanvasTeamId;
        return (
          <div
            key={`canvas-${c.teamId}`}
            className={`group flex items-center gap-1 rounded-t px-3 py-1.5 text-sm cursor-pointer border-b-2 ${
              active
                ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-2)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
            }`}
            onClick={() => onSelectCanvas?.(c.teamId)}
            title={`Canvas — ${c.teamName}`}
          >
            <Network size={12} className="text-[var(--color-accent)] shrink-0" />
            <span className="truncate max-w-[160px]">{c.teamName}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCloseCanvas?.(c.teamId);
              }}
              className={`p-0.5 rounded transition-opacity ${
                active
                  ? 'text-[var(--color-ink-muted)] hover:text-red-400'
                  : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400'
              }`}
              title="Close canvas tab"
            >
              <X size={12} />
            </button>
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
          const session = sessions.find((s) => s.id === tabMenu.sessionId);
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
                <span className="flex-1">Open chat in browser tab</span>
              </a>
              <button
                type="button"
                onClick={() => {
                  setMoveModal({ sessionId: tabMenu.sessionId });
                  setTabMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
              >
                <FolderInput size={12} />
                <span className="flex-1">Move to project…</span>
              </button>
              {!role && session && (
                <button
                  type="button"
                  onClick={() => {
                    setCreateTeamModal({
                      sessionId: session.id,
                      sessionTitle:
                        session.title ?? `Chat ${session.id.slice(0, 6)}`,
                    });
                    setTabMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                >
                  <Users size={12} />
                  <span className="flex-1">Create team from this chat…</span>
                </button>
              )}
              {role?.kind === 'orchestrator' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setAddWorkerModal({
                        teamId: role.teamId,
                        teamName: role.teamName,
                      });
                      setTabMenu(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                  >
                    <UserPlus size={12} />
                    <span className="flex-1">Add worker…</span>
                  </button>
                  {onOpenCanvasTab && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenCanvasTab({
                          teamId: role.teamId,
                          teamName: role.teamName,
                        });
                        setTabMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                    >
                      <Network size={12} />
                      <span className="flex-1">Open canvas as tab</span>
                    </button>
                  )}
                  <a
                    href={`/teams/${role.teamId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setTabMenu(null)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                  >
                    <ExternalLink size={12} />
                    <span className="flex-1">Open canvas in browser tab</span>
                  </a>
                </>
              )}
              {role?.kind === 'worker' &&
                (() => {
                  // Resolve full membership row (instructions/tags) from
                  // the teams cache the strip already keeps in state.
                  const team = teams.find((t) => t.id === role.teamId);
                  const member = team?.members.find(
                    (m) => m.sessionId === tabMenu.sessionId,
                  );
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (!member) return;
                          setEditWorkerModal({
                            teamId: role.teamId,
                            teamName: role.teamName,
                            sessionId: tabMenu.sessionId,
                            alias: member.alias,
                            instructions: member.instructions,
                            tags: member.tags,
                          });
                          setTabMenu(null);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                      >
                        <Pencil size={12} />
                        <span className="flex-1">Edit instructions &amp; tags…</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const confirmed = confirm(
                            `Remove @${role.alias} from "${role.teamName}"? The chat session stays intact and can be re-added later.`,
                          );
                          if (!confirmed) return;
                          setTabMenu(null);
                          try {
                            await api.removeTeamMember(
                              role.teamId,
                              tabMenu.sessionId,
                            );
                            window.dispatchEvent(
                              new Event('pinloom:teams-changed'),
                            );
                          } catch (err) {
                            setError(
                              err instanceof Error
                                ? err.message
                                : String(err),
                            );
                          }
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                      >
                        <UserMinus size={12} />
                        <span className="flex-1">
                          Remove from team
                          <span className="ml-1 text-[var(--color-ink-muted)]">
                            ({role.teamName})
                          </span>
                        </span>
                      </button>
                    </>
                  );
                })()}
              {canDelete && session && (
                <>
                  <div className="my-1 border-t border-[var(--color-border)]/50" />
                  <button
                    type="button"
                    onClick={() => {
                      const target = session;
                      setTabMenu(null);
                      void deleteTab(target);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-red-400"
                  >
                    <Trash2 size={12} />
                    <span className="flex-1">Delete tab</span>
                  </button>
                </>
              )}
            </div>
          );
        })()}
      {editWorkerModal && (
        <EditWorkerModal
          teamId={editWorkerModal.teamId}
          teamName={editWorkerModal.teamName}
          sessionId={editWorkerModal.sessionId}
          initialAlias={editWorkerModal.alias}
          initialInstructions={editWorkerModal.instructions}
          initialTags={editWorkerModal.tags}
          onClose={() => setEditWorkerModal(null)}
          onSaved={() => {
            setEditWorkerModal(null);
            window.dispatchEvent(new Event('pinloom:teams-changed'));
          }}
        />
      )}
      {addWorkerModal && (
        <AddWorkerFromTabModal
          teamId={addWorkerModal.teamId}
          teamName={addWorkerModal.teamName}
          currentProjectId={projectId}
          onClose={() => setAddWorkerModal(null)}
          onAdded={() => {
            setAddWorkerModal(null);
            // Refresh team membership so the worker tab gets a @alias
            // badge immediately and the canvas picks up the new edge.
            window.dispatchEvent(new Event('pinloom:teams-changed'));
          }}
        />
      )}
      {createTeamModal && (
        <CreateTeamFromSessionModal
          sessionId={createTeamModal.sessionId}
          sessionTitle={createTeamModal.sessionTitle}
          onClose={() => setCreateTeamModal(null)}
          onCreated={(team) => {
            setCreateTeamModal(null);
            // Refresh the role badges in this strip and any other surface
            // that watches for team changes (sidebar, TeamsPage, etc.).
            setTeams((prev) => [...prev, team]);
            window.dispatchEvent(new Event('pinloom:teams-changed'));
          }}
        />
      )}
      {moveModal && (
        <MoveSessionModal
          sessionId={moveModal.sessionId}
          currentProjectId={projectId}
          onClose={() => setMoveModal(null)}
          onMoved={(targetProjectId) => {
            const movedId = moveModal.sessionId;
            setMoveModal(null);
            // Drop the session from this strip so its absence is
            // immediate; the parent's onDelete handler does the same
            // bookkeeping it would for a true delete (filler session
            // takes over if this was the last tab).
            onDelete(movedId);
            // Pre-seed the target project's "last session" so the next
            // mount lands on the just-moved tab instead of whatever the
            // user happened to be on there last time.
            try {
              localStorage.setItem(
                `pinloom:lastSession:${targetProjectId}`,
                movedId,
              );
            } catch {
              // ignore storage failures
            }
            navigate(`/projects/${targetProjectId}`);
          }}
        />
      )}
    </div>
  );
}

// Modal listing every other project so the user can move the current
// session into one of them. Backend auto-creates a filler session in
// the source project if this move would leave it empty, so we don't
// have to handle "0 tabs" here — the parent's onDelete + the next
// mount of the source project will surface the filler.
function MoveSessionModal({
  sessionId,
  currentProjectId,
  onClose,
  onMoved,
}: {
  sessionId: string;
  currentProjectId: string;
  onClose: () => void;
  onMoved: (targetProjectId: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((p) => {
        if (!cancelled) setProjects(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const candidates = (projects ?? []).filter((p) => p.id !== currentProjectId);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Move session to project"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/40 px-4 py-2">
          <h2 className="text-sm font-medium">Move session to project</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4">
          {projects === null ? (
            <p className="text-xs text-[var(--color-ink-muted)]">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="text-xs text-[var(--color-ink-muted)]">
              No other projects to move into. Create one from the sidebar
              first.
            </p>
          ) : (
            <ul className="space-y-1 max-h-80 overflow-y-auto">
              {candidates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={submitting !== null}
                    onClick={async () => {
                      setError(null);
                      setSubmitting(p.id);
                      try {
                        await api.moveSession(sessionId, p.id);
                        onMoved(p.id);
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
                        setSubmitting(null);
                      }
                    }}
                    className="w-full text-left rounded border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] disabled:opacity-50 px-3 py-2 text-xs"
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[10px] text-[var(--color-ink-muted)] font-mono truncate">
                      {p.cwd}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p
              className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300"
              role="alert"
            >
              {error}
            </p>
          )}
          <p className="mt-3 text-[10px] text-[var(--color-ink-muted)]">
            The session keeps its conversation history and team
            membership. If this was the only tab in the current project,
            a fresh empty session will be created so the project stays
            usable.
          </p>
        </div>
      </div>
    </div>
  );
}

// Lightweight worker-add flow available from the orchestrator tab's
// menu. Mirrors the Teams page's full AddMemberModal but trimmed: no
// inline session creation (the user can use the + tab button if they
// need a fresh chat). Filters out sessions already bound to any team
// so we never produce a duplicate-binding error.
function AddWorkerFromTabModal({
  teamId,
  teamName,
  currentProjectId,
  onClose,
  onAdded,
}: {
  teamId: string;
  teamName: string;
  currentProjectId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [boundIds, setBoundIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [instructions, setInstructions] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Errors stay inside the modal so the user sees them where they took
  // the action (e.g. duplicate alias) instead of in the tab strip.
  const [error, setError] = useState<string | null>(null);
  // Inline session creation toggle + form state. We default the project
  // to the orchestrator's so the common case (worker in same project) is
  // a single click away; the user can pick another from the dropdown.
  const [creating, setCreating] = useState(false);
  const [newProjectId, setNewProjectId] = useState<string>(currentProjectId);
  const [newAgent, setNewAgent] = useState<'claude' | 'codex'>('claude');
  const [newTitle, setNewTitle] = useState('');
  const [creatingSubmit, setCreatingSubmit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listAllSessions(), api.listProjects(), api.listTeams()])
      .then(([s, p, t]) => {
        if (cancelled) return;
        const bound = new Set<string>();
        for (const team of t) {
          bound.add(team.orchestratorSessionId);
          for (const m of team.members) bound.add(m.sessionId);
        }
        setSessions(s);
        setProjects(p);
        setBoundIds(bound);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Bug fix: the previous version left `loading=true` on error,
        // which left the picker stuck on "Loading…" even though an
        // error banner was shown. Both states must clear together.
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't allow Escape-dismiss while a request is in flight; it
      // would leave dangling setState calls on an unmounted modal.
      if (submitting || creatingSubmit) return;
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting, creatingSubmit]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const candidates = useMemo(
    () => sessions.filter((s) => !boundIds.has(s.id)),
    [sessions, boundIds],
  );

  async function submit() {
    const a = alias.trim();
    if (!selected || !a || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.addTeamMember(teamId, {
        sessionId: selected,
        alias: a,
        instructions: instructions.trim() || null,
        tags: parseTagsInput(tagsInput),
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function createSession() {
    if (!newProjectId || creatingSubmit) return;
    setError(null);
    setCreatingSubmit(true);
    try {
      const created = await api.createSession(newProjectId, {
        agent: newAgent,
        title: newTitle.trim() || null,
      });
      setSessions((prev) => [...prev, created]);
      setSelected(created.id);
      setCreating(false);
      setNewTitle('');
      // Notify any listening surface — most importantly the parent
      // ProjectPage's tab strip — that a session just appeared. Without
      // this the strip stays stale until next mount, leaving the user
      // wondering whether their worker is really there. Detail carries
      // the full session row so listeners can splice it in without an
      // extra fetch.
      window.dispatchEvent(
        new CustomEvent('pinloom:session-created', {
          detail: { session: created },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSubmit(false);
    }
  }

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add worker"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/40 px-4 py-2">
          <h2 className="text-sm font-medium truncate">
            Add worker · {teamName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Alias
            </label>
            <input
              autoFocus
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. backend"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Used by orchestrator as <span className="font-mono">@alias</span>.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Instructions <span className="normal-case text-[10px]">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="e.g. You're the backend reviewer. Focus on schema, query plans, and migration safety. Never auto-merge."
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm resize-y"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Identity, guidelines, do/don'ts — anything that should
              color every reply. Injected into this worker's system
              prompt at run time.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Tags <span className="normal-case text-[10px]">(optional)</span>
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. backend, tests"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Comma-separated. Lowercase letters/digits/dash/underscore.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Session
            </label>
            {creating ? (
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 space-y-2">
                <div className="flex gap-2">
                  <select
                    value={newProjectId}
                    onChange={(e) => setNewProjectId(e.target.value)}
                    className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs"
                  >
                    {sortedProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
                    {(['claude', 'codex'] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setNewAgent(a)}
                        className={`px-2 py-1.5 ${
                          newAgent === a
                            ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                            : 'bg-[var(--color-surface-2)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                        }`}
                      >
                        <AgentBadge agent={a} size="xs" />
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createSession();
                  }}
                  placeholder="Title (optional)"
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={createSession}
                    disabled={!newProjectId || creatingSubmit}
                    className="rounded bg-[var(--color-accent)] text-black px-2 py-1 text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Create session
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mb-2 w-full rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1.5"
              >
                <Plus size={12} />
                Create new session
              </button>
            )}
            {loading ? (
              <p className="text-xs text-[var(--color-ink-muted)]">Loading…</p>
            ) : candidates.length === 0 ? (
              <p className="text-xs text-[var(--color-ink-muted)]">
                No free sessions. Create one above.
              </p>
            ) : (
              <ul className="space-y-1 max-h-60 overflow-y-auto">
                {candidates.map((s) => {
                  const project = projectsById.get(s.projectId);
                  const title = s.title ?? `Chat ${s.id.slice(0, 6)}`;
                  const active = selected === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(s.id)}
                        className={`w-full text-left rounded border px-3 py-2 text-xs flex items-center gap-2 ${
                          active
                            ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]'
                        }`}
                      >
                        <AgentBadge agent={s.agent} size="xs" />
                        <span className="truncate flex-1 font-medium">
                          {title}
                        </span>
                        <span className="text-[10px] text-[var(--color-ink-muted)] truncate">
                          {project?.name ?? '(unknown)'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {error && (
            <p
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!selected || alias.trim().length === 0 || submitting}
              className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Plus size={12} />
              Add worker
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Edits an existing worker's alias / instructions / tags without
// leaving the project page. Mirrors the AddWorker form, minus session
// selection (the session is fixed) and minus inline session creation.
function EditWorkerModal({
  teamId,
  teamName,
  sessionId,
  initialAlias,
  initialInstructions,
  initialTags,
  onClose,
  onSaved,
}: {
  teamId: string;
  teamName: string;
  sessionId: string;
  initialAlias: string;
  initialInstructions: string | null;
  initialTags: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [alias, setAlias] = useState(initialAlias);
  const [instructions, setInstructions] = useState(initialInstructions ?? '');
  const [tagsInput, setTagsInput] = useState(initialTags.join(', '));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (submitting) return;
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  async function submit() {
    const a = alias.trim();
    if (!a || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.updateTeamMember(teamId, sessionId, {
        alias: a,
        instructions: instructions.trim() || null,
        tags: parseTagsInput(tagsInput),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit worker"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/40 px-4 py-2">
          <h2 className="text-sm font-medium truncate">
            Edit worker · {teamName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Alias
            </label>
            <input
              autoFocus
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. backend"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Instructions <span className="normal-case text-[10px]">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder="e.g. You're the backend reviewer. Focus on schema, query plans, and migration safety. Never auto-merge."
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm resize-y"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Injected into this worker's system prompt at run time.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Tags <span className="normal-case text-[10px]">(optional)</span>
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. backend, tests"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Comma-separated. Lowercase letters/digits/dash/underscore.
            </p>
          </div>
          {error && (
            <p
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={alias.trim().length === 0 || submitting}
              className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Spawns a new team using the given session as orchestrator. Used from
// the per-tab actions menu — the session is fixed (no picker), so this
// modal only collects a team name. The caller wires up onCreated to
// refresh team-aware surfaces (badges, sidebar) without a hard reload.
function CreateTeamFromSessionModal({
  sessionId,
  sessionTitle,
  onClose,
  onCreated,
}: {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
  onCreated: (team: Team) => void;
}) {
  // Default to the session title so the user can ship without typing.
  // They can still edit before confirming if they want a different name.
  const [name, setName] = useState(sessionTitle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const team = await api.createTeam({
        name: trimmed,
        orchestratorSessionId: sessionId,
      });
      onCreated(team);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create team from this session"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/40 px-4 py-2">
          <h2 className="text-sm font-medium">Create team</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs flex items-center gap-2">
            <Crown size={12} className="text-[var(--color-accent)] shrink-0" />
            <span className="text-[var(--color-ink-muted)]">Orchestrator</span>
            <span className="truncate font-medium">{sessionTitle}</span>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Team name
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="e.g. payments-feature"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <p className="text-[10px] text-[var(--color-ink-muted)]">
            Workers can be added afterwards from the Teams page.
          </p>
          {error && (
            <p
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={name.trim().length === 0 || submitting}
              className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Plus size={12} />
              Create team
            </button>
          </div>
        </div>
      </div>
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
  // Compose tooltip from team name + tags + truncated instructions so
  // the user can scan a worker's role without opening its tab. Tooltip
  // renders as one line (whitespace-nowrap), so we use ' · ' as a soft
  // separator and truncate long instructions hard.
  const segments: string[] = [
    `@${role.alias} in team "${role.teamName}"`,
  ];
  if (role.tags.length > 0) {
    segments.push(role.tags.map((t) => `#${t}`).join(' '));
  }
  if (role.instructions) {
    const truncated =
      role.instructions.length > 120
        ? role.instructions.slice(0, 120) + '…'
        : role.instructions;
    segments.push(truncated.replace(/\s+/g, ' '));
  }
  return (
    <Tooltip label={segments.join(' · ')} side="top">
      <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-[1px] text-[10px] font-mono text-[var(--color-ink-muted)]">
        @{role.alias}
      </span>
    </Tooltip>
  );
}
