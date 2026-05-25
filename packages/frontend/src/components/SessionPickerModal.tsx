import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import type {
  Message,
  Project,
  ProjectGroup,
  Session,
} from '@pinloom/shared';
import { api } from '../api/client.js';

interface Props {
  pin: Message;
  projectId: string;
  sessions: Session[];
  currentSessionId: string;
  onClose: () => void;
  onSent?: (targetSessionId: string) => void;
  onNewSessionCreated?: (session: Session) => void;
}

interface ProjectBucket {
  project: Project;
  sessions: Session[];
  isCurrent: boolean;
}

// Top-level grouping mirrors the sidebar: named ProjectGroups +
// an 'Ungrouped' bucket for projects whose groupId is null. The
// current project's group is rendered first regardless of order_index,
// so the most likely target stays at the top of the picker.
interface GroupSection {
  key: string;
  label: string;
  isUngrouped: boolean;
  projects: ProjectBucket[];
}

export function SessionPickerModal({
  pin,
  projectId,
  sessions,
  currentSessionId,
  onClose,
  onSent,
  onNewSessionCreated,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Cross-project sessions are loaded on open so the picker can route a
  // pin into a session that lives outside the current project. The
  // caller-supplied `sessions` array is treated as the cache for the
  // current project to keep the initial render snappy; we just lay
  // other projects underneath as their data lands.
  const [allSessions, setAllSessions] = useState<Session[] | null>(null);
  const [allProjects, setAllProjects] = useState<Project[] | null>(null);
  const [allGroups, setAllGroups] = useState<ProjectGroup[] | null>(null);
  const [crossLoading, setCrossLoading] = useState(true);
  // Collapsed-by-default for other projects so the modal stays compact
  // and scannable; current project is always expanded on open. Click a
  // project header to toggle.
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set([projectId]),
  );

  function toggleProject(id: string) {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAllSessions(),
      api.listProjects(),
      api.listProjectGroups(),
    ])
      .then(([sessionList, projectList, groupList]) => {
        if (cancelled) return;
        setAllSessions(sessionList);
        setAllProjects(projectList);
        setAllGroups(groupList);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCrossLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendTo(target: Session) {
    setBusyId(target.id);
    setError(null);
    try {
      await api.injectPin(target.id, pin.id);
      setSentId(target.id);
      onSent?.(target.id);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function sendToNew() {
    setBusyId('__new__');
    setError(null);
    try {
      const created = await api.createSession(projectId, { title: null });
      onNewSessionCreated?.(created);
      await api.injectPin(created.id, pin.id);
      setSentId(created.id);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  // Sidebar-style hierarchy: ProjectGroups → Projects → Sessions. The
  // current project's group is rendered first so the most-likely target
  // sits at the top. Projects with `groupId === null` collect under a
  // synthetic 'Ungrouped' section. While the cross-project fetch is in
  // flight we fall back to a single section with just the current
  // project (using the caller-supplied `sessions`) so the modal isn't
  // empty on first paint.
  const sections: GroupSection[] = useMemo(() => {
    if (!allSessions || !allProjects || !allGroups) {
      const currentProject = { id: projectId, name: '', cwd: '' } as Project;
      return [
        {
          key: '__loading__',
          label: '',
          isUngrouped: false,
          projects: [
            {
              project: currentProject,
              sessions: sessions.filter((s) => s.id !== currentSessionId),
              isCurrent: true,
            },
          ],
        },
      ];
    }

    const sessionsByProject = new Map<string, Session[]>();
    for (const s of allSessions) {
      if (s.id === currentSessionId) continue;
      const arr = sessionsByProject.get(s.projectId) ?? [];
      arr.push(s);
      sessionsByProject.set(s.projectId, arr);
    }

    // projectId -> ProjectBucket
    const bucketByProjectId = new Map<string, ProjectBucket>();
    for (const p of allProjects) {
      bucketByProjectId.set(p.id, {
        project: p,
        sessions: sessionsByProject.get(p.id) ?? [],
        isCurrent: p.id === projectId,
      });
    }

    // groupId (or null) -> ProjectBucket[]
    const bucketsByGroupId = new Map<string | null, ProjectBucket[]>();
    for (const bucket of bucketByProjectId.values()) {
      const key = bucket.project.groupId;
      const arr = bucketsByGroupId.get(key) ?? [];
      arr.push(bucket);
      bucketsByGroupId.set(key, arr);
    }
    // Within each group, sort by project name for stable display.
    for (const arr of bucketsByGroupId.values()) {
      arr.sort((a, b) => a.project.name.localeCompare(b.project.name));
    }

    // Build sections. Current project's group comes first.
    const currentBucket = bucketByProjectId.get(projectId);
    const currentGroupId = currentBucket?.project.groupId ?? null;

    function makeSection(
      groupIdKey: string | null,
      label: string,
    ): GroupSection | null {
      const projects = bucketsByGroupId.get(groupIdKey) ?? [];
      if (projects.length === 0) return null;
      return {
        key: groupIdKey ?? '__ungrouped__',
        label,
        isUngrouped: groupIdKey === null,
        projects,
      };
    }

    const groupsById = new Map(allGroups.map((g) => [g.id, g]));
    const sortedGroups = [...allGroups].sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );

    const out: GroupSection[] = [];
    // 1. Current project's group (if any).
    if (currentGroupId !== null && groupsById.has(currentGroupId)) {
      const sec = makeSection(
        currentGroupId,
        groupsById.get(currentGroupId)?.name ?? '',
      );
      if (sec) out.push(sec);
    } else if (currentGroupId === null) {
      // Current project is itself ungrouped — surface Ungrouped first.
      const sec = makeSection(null, 'Ungrouped');
      if (sec) out.push(sec);
    }
    // 2. Other named groups, sorted by orderIndex.
    for (const g of sortedGroups) {
      if (g.id === currentGroupId) continue;
      const sec = makeSection(g.id, g.name);
      if (sec) out.push(sec);
    }
    // 3. Ungrouped at the tail (unless already surfaced as #1).
    if (currentGroupId !== null) {
      const sec = makeSection(null, 'Ungrouped');
      if (sec) out.push(sec);
    }
    return out;
  }, [
    allSessions,
    allProjects,
    allGroups,
    sessions,
    currentSessionId,
    projectId,
  ]);

  const totalOtherCount = sections.reduce(
    (sum, sec) =>
      sum +
      sec.projects.reduce(
        (s, p) => s + (p.isCurrent ? 0 : p.sessions.length),
        0,
      ),
    0,
  );
  const hasAnyOtherSession = totalOtherCount > 0;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ maxHeight: 'min(640px, 85vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Send pin to…</h2>
            <p className="text-[11px] text-[var(--color-ink-muted)] truncate max-w-[320px]">
              {pin.pinTitle ?? '(untitled pin)'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto py-1">
          <button
            onClick={sendToNew}
            disabled={busyId !== null}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          >
            <Plus size={14} className="text-[var(--color-accent)] shrink-0" />
            <span className="flex-1">Create new session (current project)</span>
            {sentId === '__new__' && <Check size={14} className="text-emerald-400" />}
          </button>

          {sections.map((sec) => {
            const secSessionCount = sec.projects.reduce(
              (s, p) => s + p.sessions.length,
              0,
            );
            return (
              <div
                key={sec.key}
                className="mt-1 border-t border-[var(--color-border)] pt-1"
              >
                {sec.label && (
                  <div className="px-3 pt-1 pb-0.5 flex items-baseline gap-2">
                    <span
                      className={`text-[10px] uppercase tracking-wide font-semibold ${
                        sec.isUngrouped
                          ? 'text-[var(--color-ink-muted)] italic'
                          : 'text-[var(--color-ink)]'
                      }`}
                    >
                      {sec.label}
                    </span>
                    <span className="text-[10px] text-[var(--color-ink-muted)]">
                      {secSessionCount}
                    </span>
                  </div>
                )}
                {sec.projects.map((g) => {
                  const expanded = expandedProjectIds.has(g.project.id);
                  return (
                    <div key={g.project.id}>
                      <button
                        type="button"
                        onClick={() => toggleProject(g.project.id)}
                        className="w-full px-4 py-1 flex items-center gap-2 text-left hover:bg-[var(--color-surface-3)]"
                      >
                        {expanded ? (
                          <ChevronDown
                            size={12}
                            className="text-[var(--color-ink-muted)] shrink-0"
                          />
                        ) : (
                          <ChevronRight
                            size={12}
                            className="text-[var(--color-ink-muted)] shrink-0"
                          />
                        )}
                        <span className="text-[11px] tracking-wide font-medium text-[var(--color-ink)]">
                          {g.project.name || '(current project)'}
                        </span>
                        {g.isCurrent && (
                          <span className="text-[10px] text-[var(--color-accent)]">
                            current
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-[var(--color-ink-muted)]">
                          {g.sessions.length}
                        </span>
                      </button>
                      {expanded &&
                        (g.sessions.length === 0 ? (
                          <p className="px-6 py-1.5 text-xs text-[var(--color-ink-muted)] italic">
                            {g.isCurrent
                              ? 'No other sessions in this project.'
                              : 'No sessions.'}
                          </p>
                        ) : (
                          g.sessions.map((s) => {
                            const label =
                              s.title ?? `Chat ${s.id.slice(0, 6)}`;
                            const busy = busyId === s.id;
                            const sent = sentId === s.id;
                            return (
                              <button
                                key={s.id}
                                onClick={() => sendTo(s)}
                                disabled={busyId !== null}
                                className="w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-sm text-left hover:bg-[var(--color-surface-3)] disabled:opacity-50"
                              >
                                <span className="flex-1 truncate">{label}</span>
                                {busy && (
                                  <span className="text-[10px] text-[var(--color-ink-muted)]">
                                    sending…
                                  </span>
                                )}
                                {sent && (
                                  <Check
                                    size={14}
                                    className="text-emerald-400"
                                  />
                                )}
                              </button>
                            );
                          })
                        ))}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {!crossLoading && !hasAnyOtherSession && (
            <p className="px-4 py-3 text-xs text-[var(--color-ink-muted)] text-center border-t border-[var(--color-border)] mt-1 pt-2">
              No sessions in other projects yet.
            </p>
          )}

          {crossLoading && (
            <p className="px-4 py-2 text-[11px] text-[var(--color-ink-muted)]">
              Loading other projects…
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-ink-muted)]">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : (
            <span>
              Pin content will be injected into the target session's next AI
              response
              {totalOtherCount > 0
                ? ` (${totalOtherCount} cross-project session${totalOtherCount === 1 ? '' : 's'} available)`
                : ''}
              .
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
