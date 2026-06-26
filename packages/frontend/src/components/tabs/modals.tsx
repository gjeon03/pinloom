// Tab-action modals (move / add-worker / edit-worker / create-team), extracted
// verbatim from the legacy SessionTabs.tsx so the dock tab menu reuses the
// exact flows the old strip shipped.

import { useEffect, useMemo, useState } from 'react';
import { Check, Crown, Plus, X } from 'lucide-react';
import type { Project, ProjectGroup, Session, Team } from '@pinloom/shared';
import { api } from '../../api/client.js';
import { AgentBadge } from '../AgentBadge.js';
import { GroupedSessionList } from '../GroupedSessionList.js';
import { useGroupedSessions } from '../../hooks/useGroupedSessions.js';
import { parseTagsInput } from './teamRoles.js';

// Modal listing every other project so the user can move the current
// session into one of them. Backend auto-creates a filler session in
// the source project if this move would leave it empty, so we don't
// have to handle "0 tabs" here — the parent's onDelete + the next
// mount of the source project will surface the filler.
export function MoveSessionModal({
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
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listProjects(), api.listProjectGroups()])
      .then(([p, g]) => {
        if (cancelled) return;
        setProjects(p);
        setGroups(g);
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
  // group → project, mirroring the sidebar (named groups by order, Ungrouped tail).
  const grouped = useMemo(() => {
    const byGroup = new Map<string | null, Project[]>();
    for (const p of candidates) {
      const arr = byGroup.get(p.groupId) ?? [];
      arr.push(p);
      byGroup.set(p.groupId, arr);
    }
    for (const arr of byGroup.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    const out: { key: string; label: string; isUngrouped: boolean; projects: Project[] }[] = [];
    for (const g of [...groups].sort((a, b) => a.orderIndex - b.orderIndex)) {
      const ps = byGroup.get(g.id);
      if (ps?.length) out.push({ key: g.id, label: g.name, isUngrouped: false, projects: ps });
    }
    const ung = byGroup.get(null);
    if (ung?.length) out.push({ key: '__ung__', label: 'Ungrouped', isUngrouped: true, projects: ung });
    return out;
  }, [candidates, groups]);

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
            <div className="max-h-80 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
              {grouped.map((sec) => (
                <div key={sec.key} className="border-b border-[var(--color-border)] last:border-b-0">
                  <div className="bg-[var(--color-surface-2)] px-3 py-1">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide ${
                        sec.isUngrouped
                          ? 'italic text-[var(--color-ink-muted)]'
                          : 'text-[var(--color-ink)]'
                      }`}
                    >
                      {sec.label}
                    </span>
                  </div>
                  {sec.projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={submitting !== null}
                      onClick={async () => {
                        setError(null);
                        setSubmitting(p.id);
                        try {
                          await api.moveSession(sessionId, p.id);
                          onMoved(p.id);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                          setSubmitting(null);
                        }
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-surface-3)] disabled:opacity-50"
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                        {p.cwd}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
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
export function AddWorkerFromTabModal({
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
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [boundIds, setBoundIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // A just-created session to reveal (expand its project + scroll + flash).
  const [revealId, setRevealId] = useState<string | null>(null);
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
    Promise.all([
      api.listAllSessions(),
      api.listProjects(),
      api.listTeams(),
      api.listProjectGroups(),
    ])
      .then(([s, p, t, g]) => {
        if (cancelled) return;
        const bound = new Set<string>();
        for (const team of t) {
          bound.add(team.orchestratorSessionId);
          for (const m of team.members) bound.add(m.sessionId);
        }
        setSessions(s);
        setProjects(p);
        setGroups(g);
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

  useEffect(() => {
    if (!revealId) return;
    const t = setTimeout(() => setRevealId(null), 1600); // stop the flash
    return () => clearTimeout(t);
  }, [revealId]);

  const candidates = useMemo(
    () => sessions.filter((s) => !boundIds.has(s.id)),
    [sessions, boundIds],
  );
  const sections = useGroupedSessions({
    sessions: candidates,
    projects,
    groups,
    currentProjectId,
    hideEmptyProjects: true,
  });

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
      setRevealId(created.id); // expand its project + scroll + flash in the list
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
            <GroupedSessionList
              sections={sections}
              loading={loading}
              initialExpandedProjectIds={[currentProjectId]}
              revealSessionId={revealId}
              emptyHint="No free sessions. Create one above."
              renderSession={(s) => {
                const title = s.title ?? `Chat ${s.id.slice(0, 6)}`;
                const active = selected === s.id;
                const flash = revealId === s.id;
                return (
                  <button
                    type="button"
                    onClick={() => setSelected(s.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                      active
                        ? 'bg-[var(--color-surface-3)] ring-1 ring-inset ring-[var(--color-accent)]'
                        : 'hover:bg-[var(--color-surface-3)]'
                    } ${flash ? 'animate-pulse' : ''}`}
                  >
                    <AgentBadge agent={s.agent} size="xs" />
                    <span className="flex-1 truncate font-medium">{title}</span>
                    {active && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
                  </button>
                );
              }}
            />
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
export function EditWorkerModal({
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
export function CreateTeamFromSessionModal({
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
