// Hosts the per-tab 3-dot actions menu (ported verbatim from the legacy
// SessionTabs) plus the four modals it can open. Lives once at ProjectPage
// level — tabs only report "open my menu at this rect" through DockContext,
// so the portal/modal state survives tab re-renders and group moves.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import useSWR, { mutate as globalMutate } from 'swr';
import {
  Columns2,
  ExternalLink,
  FolderInput,
  Network,
  Pencil,
  Rows2,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import type { Session, Team } from '@pinloom/shared';
import { api } from '../../api/client.js';
import { cacheKeys } from '../../api/cacheKeys.js';
import { buildTeamRoles } from '../tabs/teamRoles.js';
import {
  AddWorkerFromTabModal,
  CreateTeamFromSessionModal,
  EditWorkerModal,
  MoveSessionModal,
} from '../tabs/modals.js';
import type { InlineCanvasTab } from './layout.js';
import type { TabMenuRequest } from './DockContext.js';

interface Props {
  projectId: string;
  sessions: Session[];
  menu: TabMenuRequest | null;
  onCloseMenu: () => void;
  /** Delete the session (already confirmed) — API call + panel removal. */
  onDeleteSession: (sessionId: string) => Promise<void>;
  /** Local-only removal after a session moved to another project — the move
   *  already re-homed the row server-side, so NO delete API call here. */
  onSessionMovedAway: (sessionId: string) => void;
  /** Move the session's panel into a split next to its current group —
   *  the non-drag path to a VSCode-style side-by-side. */
  onSplit: (sessionId: string, direction: 'right' | 'down') => void;
  /** Open (or focus) a canvas tab for this team. */
  onOpenCanvasTab: (tab: InlineCanvasTab) => void;
  onError: (message: string) => void;
}

export function TabMenuHost({
  projectId,
  sessions,
  menu,
  onCloseMenu,
  onDeleteSession,
  onSessionMovedAway,
  onSplit,
  onOpenCanvasTab,
  onError,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
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

  // Team membership lookup so menu items adapt to the session's role.
  // `pinloom:teams-changed` is handled centrally in App.tsx which mutates
  // cacheKeys.teams() — all consumers refresh from one shared inflight.
  const { data: teams = [] } = useSWR(cacheKeys.teams(), () => api.listTeams());
  const rolesBySessionId = useMemo(() => buildTeamRoles(teams), [teams]);

  // Click-outside dismiss for the menu (modals handle their own).
  useEffect(() => {
    if (!menu) return;
    function onClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !(e.target as Element).closest('[data-tab-menu-trigger]')
      ) {
        onCloseMenu();
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menu, onCloseMenu]);

  const canDelete = sessions.length > 1;

  async function deleteTab(session: Session) {
    if (!canDelete) return;
    if (
      !confirm(
        `Delete "${session.title ?? 'untitled'}"? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await onDeleteSession(session.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      {menu &&
        (() => {
          const role = rolesBySessionId.get(menu.sessionId) ?? null;
          const session = sessions.find((s) => s.id === menu.sessionId);
          return createPortal(
            <div
              ref={menuRef}
              style={{
                position: 'fixed',
                top: menu.top,
                left: menu.left,
                zIndex: 50,
              }}
              className="min-w-[180px] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg py-1 text-xs"
            >
              <a
                href={`/s/${menu.sessionId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onCloseMenu}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-[var(--color-ink)]"
              >
                <ExternalLink size={12} />
                <span className="flex-1">Open chat in browser tab</span>
              </a>
              <button
                type="button"
                onClick={() => {
                  onSplit(menu.sessionId, 'right');
                  onCloseMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
              >
                <Columns2 size={12} />
                <span className="flex-1">Split right</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSplit(menu.sessionId, 'down');
                  onCloseMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
              >
                <Rows2 size={12} />
                <span className="flex-1">Split down</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoveModal({ sessionId: menu.sessionId });
                  onCloseMenu();
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
                    onCloseMenu();
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
                      onCloseMenu();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                  >
                    <UserPlus size={12} />
                    <span className="flex-1">Add worker…</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenCanvasTab({
                        teamId: role.teamId,
                        teamName: role.teamName,
                      });
                      onCloseMenu();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                  >
                    <Network size={12} />
                    <span className="flex-1">Open canvas as tab</span>
                  </button>
                  <a
                    href={`/teams/${role.teamId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onCloseMenu}
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
                  // the teams cache this host already keeps via SWR.
                  const team = teams.find((t) => t.id === role.teamId);
                  const member = team?.members.find(
                    (m) => m.sessionId === menu.sessionId,
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
                            sessionId: menu.sessionId,
                            alias: member.alias,
                            instructions: member.instructions,
                            tags: member.tags,
                          });
                          onCloseMenu();
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-[var(--color-ink)]"
                      >
                        <Pencil size={12} />
                        <span className="flex-1">
                          Edit instructions &amp; tags…
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const confirmed = confirm(
                            `Remove @${role.alias} from "${role.teamName}"? The chat session stays intact and can be re-added later.`,
                          );
                          if (!confirmed) return;
                          onCloseMenu();
                          try {
                            await api.removeTeamMember(
                              role.teamId,
                              menu.sessionId,
                            );
                            window.dispatchEvent(
                              new Event('pinloom:teams-changed'),
                            );
                          } catch (err) {
                            onError(
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
                      onCloseMenu();
                      void deleteTab(target);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] text-left text-red-400"
                  >
                    <Trash2 size={12} />
                    <span className="flex-1">Delete tab</span>
                  </button>
                </>
              )}
            </div>,
            document.body,
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
            // Optimistically append to the shared SWR cache so badges
            // appear instantly. The subsequent `pinloom:teams-changed`
            // dispatch makes App.tsx's central listener revalidate the
            // same key — safe because better-sqlite3 is synchronous, so
            // the POST that produced `team` is already durably visible
            // before this handler runs (no read-your-write race).
            void globalMutate(
              cacheKeys.teams(),
              (prev: Team[] | undefined) => [...(prev ?? []), team],
              { revalidate: false },
            );
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
            // Drop the session from this project's dock — LOCAL bookkeeping
            // only; the move already re-homed the row server-side, so a
            // delete API call here would destroy the moved session.
            onSessionMovedAway(movedId);
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
    </>
  );
}
