import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Users,
  X,
  Pencil,
  Check,
  ExternalLink,
} from 'lucide-react';
import type { Project, Session, Team, TeamMember } from '@pinloom/shared';
import { api } from '../api/client.js';
import { AgentBadge } from '../components/AgentBadge.js';
import { DirectoryPicker } from '../components/DirectoryPicker.js';

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'project';
}

interface SessionLookup {
  sessionsById: Record<string, Session>;
  projectsById: Record<string, Project>;
  /** Sessions bound to any team (orchestrator OR worker). */
  boundSessionIds: Set<string>;
}

interface SessionLabel {
  title: string;
  subtitle: string;
  agent: Session['agent'] | null;
}

function formatSessionLabel(
  sessionId: string,
  lookup: SessionLookup,
): SessionLabel {
  const session = lookup.sessionsById[sessionId];
  if (!session) {
    return {
      title: '(deleted session)',
      subtitle: sessionId.slice(0, 8),
      agent: null,
    };
  }
  const project = lookup.projectsById[session.projectId];
  return {
    title: session.title ?? 'Untitled session',
    subtitle: project?.name ?? '(unknown project)',
    agent: session.agent,
  };
}

export function TeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Guards against an in-flight refresh being clobbered by an older one
  // when the user mutates state quickly (rapid create/delete).
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    try {
      const [t, p, s] = await Promise.all([
        api.listTeams(),
        api.listProjects(),
        api.listAllSessions(),
      ]);
      if (seq !== refreshSeqRef.current) return;
      setTeams(t);
      setProjects(p);
      setAllSessions(s);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const lookup = useMemo<SessionLookup>(() => {
    const sessionsById: Record<string, Session> = {};
    for (const s of allSessions) sessionsById[s.id] = s;
    const projectsById: Record<string, Project> = {};
    for (const p of projects) projectsById[p.id] = p;
    const bound = new Set<string>();
    for (const team of teams ?? []) {
      bound.add(team.orchestratorSessionId);
      for (const m of team.members) bound.add(m.sessionId);
    }
    return { sessionsById, projectsById, boundSessionIds: bound };
  }, [allSessions, projects, teams]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2 mb-2">
          <Users size={18} className="text-[var(--color-ink-muted)]" />
          <h1 className="text-lg font-semibold">Teams</h1>
        </div>
        <p className="text-xs text-[var(--color-ink-muted)] mb-6 max-w-prose">
          Group an orchestrator session with worker sessions so the orchestrator
          can dispatch tasks across them by alias. Workers stay usable as
          standalone sessions — team membership is additive.
        </p>

        <CreateTeamPanel
          lookup={lookup}
          onCreated={refresh}
          onError={setError}
        />

        {error && (
          <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss"
              className="ml-2"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {teams === null ? (
          <p className="text-sm text-[var(--color-ink-muted)]">Loading…</p>
        ) : teams.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">
            No teams yet. Create one above.
          </p>
        ) : (
          <ul className="space-y-3">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                lookup={lookup}
                onChanged={refresh}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface CreateTeamPanelProps {
  lookup: SessionLookup;
  onCreated: () => void;
  onError: (msg: string) => void;
}

function CreateTeamPanel({
  lookup,
  onCreated,
  onError,
}: CreateTeamPanelProps) {
  const [name, setName] = useState('');
  const [pickingOrchestrator, setPickingOrchestrator] = useState(false);
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || !orchestratorId) return;
    try {
      await api.createTeam({
        name: trimmed,
        orchestratorSessionId: orchestratorId,
      });
      setName('');
      setOrchestratorId(null);
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const orchLabel = orchestratorId
    ? formatSessionLabel(orchestratorId, lookup)
    : null;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mb-6">
      <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1.5">
        Create new team
      </label>
      <div className="flex gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
          placeholder="Team name (e.g. payments-feature)"
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => setPickingOrchestrator(true)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1.5 max-w-xs truncate"
        >
          {orchLabel ? (
            <>
              {orchLabel.agent && (
                <AgentBadge agent={orchLabel.agent} size="xs" />
              )}
              <span className="truncate">{orchLabel.title}</span>
            </>
          ) : (
            <span>Pick orchestrator…</span>
          )}
        </button>
        <button
          type="button"
          onClick={create}
          disabled={name.trim().length === 0 || !orchestratorId}
          className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <Plus size={12} />
          Create
        </button>
      </div>

      {pickingOrchestrator && (
        <SessionPickerModal
          title="Pick orchestrator session"
          lookup={lookup}
          /* The new team has no current orchestrator yet — only show free sessions. */
          allowSessionId={null}
          onClose={() => setPickingOrchestrator(false)}
          onPick={(id) => {
            setOrchestratorId(id);
            setPickingOrchestrator(false);
          }}
        />
      )}
    </div>
  );
}

interface TeamCardProps {
  team: Team;
  lookup: SessionLookup;
  onChanged: () => void;
  onError: (msg: string) => void;
}

function TeamCard({ team, lookup, onChanged, onError }: TeamCardProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(team.name);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showOrchestratorPicker, setShowOrchestratorPicker] = useState(false);

  // Re-seed draft when the team changes underneath us (rename via another path).
  useEffect(() => {
    setNameDraft(team.name);
  }, [team.name]);

  async function saveName() {
    const next = nameDraft.trim();
    if (!next || next === team.name) {
      setEditingName(false);
      setNameDraft(team.name);
      return;
    }
    try {
      await api.updateTeam(team.id, { name: next });
      setEditingName(false);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteThisTeam() {
    if (!confirm('Delete this team? Member sessions are preserved.')) return;
    try {
      await api.deleteTeam(team.id);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <li className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') {
                    setEditingName(false);
                    setNameDraft(team.name);
                  }
                }}
                autoFocus
                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={saveName}
                aria-label="Save"
                className="text-[var(--color-accent)]"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="text-sm font-medium text-[var(--color-ink)] hover:text-[var(--color-accent)] flex items-center gap-1.5 group"
            >
              {team.name}
              <Pencil
                size={11}
                className="opacity-0 group-hover:opacity-50 transition-opacity"
              />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={deleteThisTeam}
          aria-label="Delete team"
          title="Delete team"
          className="text-[var(--color-ink-muted)] hover:text-red-400"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="space-y-2">
        <Section label="Orchestrator">
          <div className="flex items-center gap-2">
            <SessionRow
              sessionId={team.orchestratorSessionId}
              lookup={lookup}
              alias="orchestrator"
            />
            <button
              type="button"
              onClick={() => setShowOrchestratorPicker(true)}
              className="rounded border border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]"
            >
              Change
            </button>
          </div>
        </Section>

        <Section label={`Workers (${team.members.length})`}>
          {team.members.length === 0 && (
            <p className="text-xs text-[var(--color-ink-muted)] mb-2">
              No workers yet.
            </p>
          )}
          <ul className="space-y-1.5">
            {team.members.map((m) => (
              <MemberRow
                key={m.sessionId}
                teamId={team.id}
                member={m}
                lookup={lookup}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShowAddMember(true)}
            className="mt-2 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] w-full text-left flex items-center gap-1.5"
          >
            <Plus size={12} />
            Add worker
          </button>
        </Section>
      </div>

      {showOrchestratorPicker && (
        <SessionPickerModal
          title="Change orchestrator"
          lookup={lookup}
          allowSessionId={team.orchestratorSessionId}
          onClose={() => setShowOrchestratorPicker(false)}
          onPick={async (sessionId) => {
            try {
              await api.updateTeam(team.id, {
                orchestratorSessionId: sessionId,
              });
              setShowOrchestratorPicker(false);
              onChanged();
            } catch (err) {
              onError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}

      {showAddMember && (
        <AddMemberModal
          team={team}
          lookup={lookup}
          onClose={() => setShowAddMember(false)}
          onDone={onChanged}
          onError={onError}
        />
      )}
    </li>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

interface SessionRowProps {
  sessionId: string;
  lookup: SessionLookup;
  alias: string;
}

function SessionRow({ sessionId, lookup, alias }: SessionRowProps) {
  const meta = formatSessionLabel(sessionId, lookup);
  return (
    <div className="flex-1 flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[var(--color-accent)] shrink-0">
          @{alias}
        </span>
        {meta.agent && <AgentBadge agent={meta.agent} size="xs" />}
        <span className="truncate">{meta.title}</span>
        <span className="text-[var(--color-ink-muted)] shrink-0">
          · {meta.subtitle}
        </span>
      </div>
      <Link
        to={`/s/${sessionId}`}
        aria-label="Open session"
        className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] shrink-0"
        title="Open session"
      >
        <ExternalLink size={11} />
      </Link>
    </div>
  );
}

interface MemberRowProps {
  teamId: string;
  member: TeamMember;
  lookup: SessionLookup;
  onChanged: () => void;
  onError: (msg: string) => void;
}

function MemberRow({
  teamId,
  member,
  lookup,
  onChanged,
  onError,
}: MemberRowProps) {
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(member.alias);
  const meta = formatSessionLabel(member.sessionId, lookup);

  useEffect(() => {
    setAliasDraft(member.alias);
  }, [member.alias]);

  async function saveAlias() {
    const next = aliasDraft.trim();
    if (!next || next === member.alias) {
      setEditingAlias(false);
      setAliasDraft(member.alias);
      return;
    }
    try {
      await api.updateTeamMember(teamId, member.sessionId, { alias: next });
      setEditingAlias(false);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <li className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        {editingAlias ? (
          <input
            type="text"
            value={aliasDraft}
            onChange={(e) => setAliasDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveAlias();
              if (e.key === 'Escape') {
                setEditingAlias(false);
                setAliasDraft(member.alias);
              }
            }}
            autoFocus
            spellCheck={false}
            className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs font-mono"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingAlias(true)}
            title="Edit alias"
            className="font-mono text-[var(--color-accent)] hover:underline shrink-0"
          >
            @{member.alias}
          </button>
        )}
        {meta.agent && <AgentBadge agent={meta.agent} size="xs" />}
        <span className="truncate">{meta.title}</span>
        <span className="text-[var(--color-ink-muted)] shrink-0">
          · {meta.subtitle}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Link
          to={`/s/${member.sessionId}`}
          aria-label="Open session"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
          title="Open session"
        >
          <ExternalLink size={11} />
        </Link>
        <button
          type="button"
          onClick={async () => {
            try {
              await api.removeTeamMember(teamId, member.sessionId);
              onChanged();
            } catch (err) {
              onError(err instanceof Error ? err.message : String(err));
            }
          }}
          aria-label="Remove worker"
          title="Remove worker"
          className="text-[var(--color-ink-muted)] hover:text-red-400"
        >
          <X size={12} />
        </button>
      </div>
    </li>
  );
}

interface SessionPickerModalProps {
  title: string;
  lookup: SessionLookup;
  /**
   * Session id that should *also* be selectable even if currently bound
   * — used when changing a team's orchestrator (the team's current
   * orchestrator is "bound to itself" but should be re-pickable).
   */
  allowSessionId: string | null;
  onClose: () => void;
  onPick: (sessionId: string) => void;
}

function SessionPickerModal({
  title,
  lookup,
  allowSessionId,
  onClose,
  onPick,
}: SessionPickerModalProps) {
  const [creating, setCreating] = useState(false);

  const candidates = useMemo(() => {
    return Object.values(lookup.sessionsById).filter(
      (s) => !lookup.boundSessionIds.has(s.id) || s.id === allowSessionId,
    );
  }, [lookup, allowSessionId]);

  return (
    <ModalShell title={title} onClose={onClose}>
      {creating ? (
        <NewSessionForm
          projects={Object.values(lookup.projectsById)}
          onCancel={() => setCreating(false)}
          onCreated={(s) => onPick(s.id)}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mb-3 w-full rounded border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1.5"
          >
            <Plus size={12} />
            Create new session
          </button>
          {candidates.length === 0 ? (
            <p className="text-xs text-[var(--color-ink-muted)]">
              No available sessions to pick from. Create a new one above.
            </p>
          ) : (
            <ul className="space-y-1 max-h-80 overflow-y-auto">
              {candidates.map((s) => {
                const meta = formatSessionLabel(s.id, lookup);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onPick(s.id)}
                      className="w-full text-left rounded border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] px-3 py-2 text-xs flex items-center gap-2"
                    >
                      {meta.agent && <AgentBadge agent={meta.agent} size="xs" />}
                      <span className="truncate flex-1">{meta.title}</span>
                      <span className="text-[var(--color-ink-muted)] shrink-0">
                        {meta.subtitle}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </ModalShell>
  );
}

interface AddMemberModalProps {
  team: Team;
  lookup: SessionLookup;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function AddMemberModal({
  team,
  lookup,
  onClose,
  onDone,
  onError,
}: AddMemberModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [creating, setCreating] = useState(false);
  // Sessions just-created via the inline form. Held locally because the
  // parent's `lookup` won't refresh until we commit the team membership;
  // we still want to show + select them in the picker right away.
  const [extras, setExtras] = useState<Session[]>([]);

  const candidates = useMemo(() => {
    const base = Object.values(lookup.sessionsById).filter(
      (s) => !lookup.boundSessionIds.has(s.id),
    );
    const extraIds = new Set(extras.map((e) => e.id));
    const filteredBase = base.filter((s) => !extraIds.has(s.id));
    return [...extras, ...filteredBase];
  }, [lookup, extras]);

  function describe(s: Session): SessionLabel {
    const project = lookup.projectsById[s.projectId];
    return {
      title: s.title ?? 'Untitled session',
      subtitle: project?.name ?? '(unknown project)',
      agent: s.agent,
    };
  }

  async function add() {
    if (!selected || !alias.trim()) return;
    try {
      await api.addTeamMember(team.id, {
        sessionId: selected,
        alias: alias.trim(),
      });
      onDone();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ModalShell title="Add worker" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
            Alias
          </label>
          <input
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="e.g. backend"
            spellCheck={false}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
          />
          <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
            Lowercase letters/digits/dash/underscore. Used by orchestrator as
            <span className="font-mono"> @alias</span>.
          </p>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
            Session
          </label>
          {creating ? (
            <NewSessionForm
              projects={Object.values(lookup.projectsById)}
              onCancel={() => setCreating(false)}
              onCreated={(s) => {
                setExtras((prev) => [...prev, s]);
                setSelected(s.id);
                setCreating(false);
              }}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mb-2 w-full rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1.5"
              >
                <Plus size={12} />
                Create new session
              </button>
              {candidates.length === 0 ? (
                <p className="text-xs text-[var(--color-ink-muted)]">
                  No free sessions. Create one above.
                </p>
              ) : (
                <ul className="space-y-1 max-h-60 overflow-y-auto">
                  {candidates.map((s) => {
                    const meta = describe(s);
                    const active = selected === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(s.id)}
                          className={`w-full text-left rounded border px-3 py-2 text-xs flex items-center gap-2 ${
                            active
                              ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]/50'
                              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]'
                          }`}
                        >
                          {meta.agent && <AgentBadge agent={meta.agent} size="xs" />}
                          <span className="truncate flex-1">{meta.title}</span>
                          <span className="text-[var(--color-ink-muted)] shrink-0">
                            {meta.subtitle}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={add}
            disabled={!selected || !alias.trim()}
            className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

interface NewSessionFormProps {
  projects: Project[];
  onCancel: () => void;
  onCreated: (session: Session) => void;
}

// Inline session creation surfaced inside the orchestrator/worker pickers
// so users don't have to navigate to a project page and come back. The
// form is intentionally minimal — project + agent + optional title; the
// session inherits everything else from the project's defaults. If the
// user has no projects yet (or wants a new one for this session), the
// "+ New project" button opens the same DirectoryPicker the sidebar uses.
function NewSessionForm({ projects, onCancel, onCreated }: NewSessionFormProps) {
  // Local copy so a project created inline is immediately visible in the
  // dropdown without round-tripping through the parent.
  const [localProjects, setLocalProjects] = useState<Project[]>(projects);
  useEffect(() => {
    setLocalProjects((prev) => {
      // Merge — prefer local state for any project we just created so a
      // re-prop from the parent doesn't drop our optimistic addition.
      const ids = new Set(prev.map((p) => p.id));
      const merged = [...prev];
      for (const p of projects) if (!ids.has(p.id)) merged.push(p);
      return merged;
    });
  }, [projects]);

  const sortedProjects = useMemo(
    () => [...localProjects].sort((a, b) => a.name.localeCompare(b.name)),
    [localProjects],
  );
  const [projectId, setProjectId] = useState<string>(
    sortedProjects[0]?.id ?? '',
  );
  // Keep selection in sync as projects change (e.g., user creates one).
  useEffect(() => {
    if (!projectId && sortedProjects[0]) {
      setProjectId(sortedProjects[0].id);
    }
  }, [sortedProjects, projectId]);

  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);

  async function submit() {
    if (!projectId || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const session = await api.createSession(projectId, {
        agent,
        title: title.trim() || null,
      });
      onCreated(session);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDirChosen(cwd: string) {
    setShowDirPicker(false);
    setErr(null);
    try {
      const name = basenameOfPath(cwd);
      const created = await api.createProject({ name, cwd, groupId: null });
      setLocalProjects((prev) => [created, ...prev]);
      setProjectId(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Empty state: no projects exist yet → show a single CTA that opens
  // the directory picker. After creation we drop into the regular form.
  if (sortedProjects.length === 0) {
    return (
      <>
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2 text-xs">
          <p className="text-[var(--color-ink-muted)]">
            No projects yet. Pick a directory to start one — pinloom uses it as
            the session's working directory.
          </p>
          {err && <p className="text-red-400">{err}</p>}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setShowDirPicker(true)}
              className="rounded bg-[var(--color-accent)] text-black px-2.5 py-1 text-[11px] font-medium flex items-center gap-1"
            >
              <Plus size={11} />
              Pick directory…
            </button>
          </div>
        </div>
        {showDirPicker && (
          <DirectoryPicker
            onSelect={handleDirChosen}
            onClose={() => setShowDirPicker(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2.5">
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
          Project
        </label>
        <div className="flex gap-1.5">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs"
          >
            {sortedProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowDirPicker(true)}
            title="Create new project"
            aria-label="Create new project"
            className="rounded border border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1"
          >
            <Plus size={11} />
            New
          </button>
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
          Agent
        </label>
        <div className="flex gap-1.5">
          {(['claude', 'codex'] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              onClick={() => setAgent(kind)}
              className={`flex-1 rounded border px-2 py-1.5 text-xs flex items-center justify-center gap-1.5 ${
                agent === kind
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]/50 text-[var(--color-ink)]'
                  : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              <AgentBadge agent={kind} size="xs" />
              <span className="capitalize">{kind}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
          Title <span className="text-[10px]">(optional)</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled session"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs"
        />
      </div>
      {err && (
        <p className="text-xs text-red-400">{err}</p>
      )}
      <div className="flex justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Back
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !projectId}
          className="rounded bg-[var(--color-accent)] text-black px-2.5 py-1 text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Creating…' : 'Create session'}
        </button>
      </div>
    </div>
    {showDirPicker && (
      <DirectoryPicker
        onSelect={handleDirChosen}
        onClose={() => setShowDirPicker(false)}
      />
    )}
    </>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Escape closes the dialog. Same handler for every modal so behavior is
  // consistent across orchestrator picker / add-member / future surfaces.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/40 px-4 py-2">
          <h2 className="text-sm font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
