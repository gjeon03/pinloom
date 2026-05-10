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
  Network,
} from 'lucide-react';
import type {
  Project,
  ProjectGroup,
  Session,
  Team,
  TeamMember,
} from '@pinloom/shared';
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
  /** Project groups, included so the inline "create new project" form can
   *  let users pick a group instead of always landing in Ungrouped. */
  projectGroups: ProjectGroup[];
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
    title: session.title ?? `Chat ${session.id.slice(0, 6)}`,
    subtitle: project?.name ?? '(unknown project)',
    agent: session.agent,
  };
}

export function TeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Guards against an in-flight refresh being clobbered by an older one
  // when the user mutates state quickly (rapid create/delete).
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    try {
      const [t, p, g, s] = await Promise.all([
        api.listTeams(),
        api.listProjects(),
        api.listProjectGroups(),
        api.listAllSessions(),
      ]);
      if (seq !== refreshSeqRef.current) return;
      setTeams(t);
      setProjects(p);
      setProjectGroups(g);
      setAllSessions(s);
      // Notify any session-tab strip currently mounted in the app so its
      // "@alias" / "orchestrator" badges stay in sync without the user
      // having to navigate.
      window.dispatchEvent(new CustomEvent('pinloom:teams-changed'));
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
    return {
      sessionsById,
      projectsById,
      projectGroups,
      boundSessionIds: bound,
    };
  }, [allSessions, projects, projectGroups, teams]);

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
  // Optional briefing for the orchestrator session. Mirrors a worker's
  // instructions field — same trim-to-null UX as the worker AddWorker
  // form. Hidden behind a toggle so the create panel stays compact for
  // users who don't need it.
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructions, setInstructions] = useState('');
  // Sessions/projects created via the inline picker before the parent
  // lookup has refetched. Used so the orchestrator preview label resolves
  // immediately after creation.
  const [extraSessions, setExtraSessions] = useState<Session[]>([]);
  const [extraProjects, setExtraProjects] = useState<Project[]>([]);

  const enrichedLookup = useMemo<SessionLookup>(() => {
    const sessionsById = { ...lookup.sessionsById };
    for (const s of extraSessions) sessionsById[s.id] = s;
    const projectsById = { ...lookup.projectsById };
    for (const p of extraProjects) projectsById[p.id] = p;
    return { ...lookup, sessionsById, projectsById };
  }, [lookup, extraSessions, extraProjects]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || !orchestratorId) return;
    try {
      await api.createTeam({
        name: trimmed,
        orchestratorSessionId: orchestratorId,
        instructions: instructions.trim() || null,
      });
      setName('');
      setOrchestratorId(null);
      setInstructions('');
      setShowInstructions(false);
      setExtraSessions([]);
      setExtraProjects([]);
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const orchLabel = orchestratorId
    ? formatSessionLabel(orchestratorId, enrichedLookup)
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
      <div className="mt-2">
        {showInstructions ? (
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
              Orchestrator briefing <span className="normal-case">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="e.g. You're the PM. Synthesize across workers, escalate blockers, never auto-merge."
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm resize-y"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Injected into the orchestrator's system prompt every turn.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowInstructions(true)}
            className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
          >
            + Add orchestrator briefing (optional)
          </button>
        )}
      </div>

      {pickingOrchestrator && (
        <SessionPickerModal
          title="Pick orchestrator session"
          lookup={enrichedLookup}
          /* The new team has no current orchestrator yet — only show free sessions. */
          allowSessionId={null}
          onClose={() => setPickingOrchestrator(false)}
          onPick={(id) => {
            setOrchestratorId(id);
            setPickingOrchestrator(false);
          }}
          onSessionCreated={(s) => setExtraSessions((p) => [...p, s])}
          onProjectCreated={(p) => setExtraProjects((prev) => [...prev, p])}
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
  // Briefing edit panel — same rhythm as MemberRow's instructions edit.
  const [editingBriefing, setEditingBriefing] = useState(false);
  const [briefingDraft, setBriefingDraft] = useState(team.instructions ?? '');
  const [savingBriefing, setSavingBriefing] = useState(false);

  // Re-seed draft when the team changes underneath us (rename via another path).
  useEffect(() => {
    setNameDraft(team.name);
  }, [team.name]);
  useEffect(() => {
    if (!editingBriefing) {
      setBriefingDraft(team.instructions ?? '');
    }
  }, [team.instructions, editingBriefing]);

  async function saveBriefing() {
    if (savingBriefing) return;
    setSavingBriefing(true);
    try {
      await api.updateTeam(team.id, {
        instructions: briefingDraft.trim() || null,
      });
      setEditingBriefing(false);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBriefing(false);
    }
  }

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
        <Link
          to={`/teams/${team.id}`}
          aria-label="Open canvas"
          title="Open canvas"
          className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1"
        >
          <Network size={12} />
          Canvas
        </Link>
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

        <Section label="Briefing">
          {editingBriefing ? (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 space-y-2">
              <textarea
                value={briefingDraft}
                onChange={(e) => setBriefingDraft(e.target.value)}
                rows={3}
                placeholder="Optional. Identity, priorities, do/don'ts for the orchestrator."
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs resize-y"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingBriefing(false);
                    setBriefingDraft(team.instructions ?? '');
                  }}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveBriefing}
                  disabled={savingBriefing}
                  className="rounded bg-[var(--color-accent)] text-black px-2 py-1 text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
            </div>
          ) : team.instructions ? (
            <button
              type="button"
              onClick={() => setEditingBriefing(true)}
              title="Edit briefing"
              className="w-full text-left rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)]"
            >
              <span className="text-[var(--color-ink-muted)] line-clamp-2 whitespace-pre-line">
                {team.instructions}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditingBriefing(true)}
              className="rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] w-full text-left flex items-center gap-1.5"
            >
              <Plus size={12} />
              Add briefing
            </button>
          )}
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
  // Instructions / tags edit happens in a small inline panel below the row
  // so users don't lose their place in the team list.
  const [editingExtras, setEditingExtras] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(member.instructions ?? '');
  const [tagsDraft, setTagsDraft] = useState(member.tags.join(', '));
  const [savingExtras, setSavingExtras] = useState(false);
  const meta = formatSessionLabel(member.sessionId, lookup);

  useEffect(() => {
    setAliasDraft(member.alias);
  }, [member.alias]);
  useEffect(() => {
    if (!editingExtras) {
      setInstructionsDraft(member.instructions ?? '');
      setTagsDraft(member.tags.join(', '));
    }
  }, [member.instructions, member.tags, editingExtras]);

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

  async function saveExtras() {
    if (savingExtras) return;
    setSavingExtras(true);
    try {
      await api.updateTeamMember(teamId, member.sessionId, {
        instructions: instructionsDraft.trim() || null,
        tags: parseTags(tagsDraft),
      });
      setEditingExtras(false);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingExtras(false);
    }
  }

  return (
    <li className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
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
          {member.tags.length > 0 && !editingExtras && (
            <span className="ml-1 flex flex-wrap gap-1 min-w-0">
              {member.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-[var(--color-surface-2)] px-1 text-[10px] font-mono text-[var(--color-ink-muted)]"
                >
                  #{t}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setEditingExtras((v) => !v)}
            aria-label="Edit instructions and tags"
            title="Edit instructions and tags"
            className={`text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] ${
              editingExtras ? 'text-[var(--color-accent)]' : ''
            }`}
          >
            <Pencil size={11} />
          </button>
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
      </div>
      {!editingExtras && member.instructions && (
        <div className="px-3 pb-1.5 text-[10px] text-[var(--color-ink-muted)] line-clamp-2">
          {member.instructions}
        </div>
      )}
      {editingExtras && (
        <div className="border-t border-[var(--color-border)]/50 px-3 py-2 space-y-2">
          <div>
            <label className="block text-[9px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-0.5">
              Instructions
            </label>
            <textarea
              value={instructionsDraft}
              onChange={(e) => setInstructionsDraft(e.target.value)}
              rows={3}
              placeholder="Optional system-prompt-style blurb."
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs resize-y"
            />
          </div>
          <div>
            <label className="block text-[9px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-0.5">
              Tags
            </label>
            <input
              type="text"
              value={tagsDraft}
              onChange={(e) => setTagsDraft(e.target.value)}
              placeholder="comma, separated"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditingExtras(false);
                setInstructionsDraft(member.instructions ?? '');
                setTagsDraft(member.tags.join(', '));
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveExtras}
              disabled={savingExtras}
              className="rounded bg-[var(--color-accent)] text-black px-2 py-1 text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// Same comma/whitespace-tolerant tag splitter as the SessionTabs side
// uses. Server-side validation owns the final pattern check; this just
// keeps the request body clean and de-duplicated.
function parseTags(raw: string): string[] {
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
  /** Surfaces inline-created sessions/projects so the parent can
   *  optimistically merge them into its own lookup. */
  onSessionCreated?: (session: Session) => void;
  onProjectCreated?: (project: Project) => void;
}

function SessionPickerModal({
  title,
  lookup,
  allowSessionId,
  onClose,
  onPick,
  onSessionCreated,
  onProjectCreated,
}: SessionPickerModalProps) {
  const [creating, setCreating] = useState(false);

  const candidates = useMemo(() => {
    return Object.values(lookup.sessionsById).filter(
      (s) => !lookup.boundSessionIds.has(s.id) || s.id === allowSessionId,
    );
  }, [lookup, allowSessionId]);

  // Inline-created projects haven't propagated back to the parent's
  // lookup yet — merge them so the picker that opens on next click sees
  // them too.
  const projectsForForm = useMemo(
    () => Object.values(lookup.projectsById),
    [lookup.projectsById],
  );

  return (
    <ModalShell title={title} onClose={onClose}>
      {creating ? (
        <NewSessionForm
          projects={projectsForForm}
          projectGroups={lookup.projectGroups}
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            onSessionCreated?.(s);
            onPick(s.id);
          }}
          onProjectCreated={onProjectCreated}
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
  // Sessions/projects just-created via the inline form. Held locally
  // because the parent's `lookup` won't refresh until we commit the
  // team membership; we still want to show + select them right away.
  const [extras, setExtras] = useState<Session[]>([]);
  const [extraProjects, setExtraProjects] = useState<Project[]>([]);

  const projectsById = useMemo(() => {
    const merged: Record<string, Project> = { ...lookup.projectsById };
    for (const p of extraProjects) merged[p.id] = p;
    return merged;
  }, [lookup.projectsById, extraProjects]);

  const candidates = useMemo(() => {
    const base = Object.values(lookup.sessionsById).filter(
      (s) => !lookup.boundSessionIds.has(s.id),
    );
    const extraIds = new Set(extras.map((e) => e.id));
    const filteredBase = base.filter((s) => !extraIds.has(s.id));
    return [...extras, ...filteredBase];
  }, [lookup, extras]);

  function describe(s: Session): SessionLabel {
    const project = projectsById[s.projectId];
    return {
      title: s.title ?? `Chat ${s.id.slice(0, 6)}`,
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
              projects={Object.values(projectsById)}
              projectGroups={lookup.projectGroups}
              onCancel={() => setCreating(false)}
              onCreated={(s) => {
                setExtras((prev) => [...prev, s]);
                setSelected(s.id);
                setCreating(false);
              }}
              onProjectCreated={(p) =>
                setExtraProjects((prev) => [...prev, p])
              }
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
  projectGroups: ProjectGroup[];
  onCancel: () => void;
  onCreated: (session: Session) => void;
  /** Surfaces an inline-created project so the parent modal can render
   *  it in the candidate list before the global state refetches. */
  onProjectCreated?: (project: Project) => void;
}

// Inline session creation surfaced inside the orchestrator/worker pickers
// so users don't have to navigate to a project page and come back. The
// form is intentionally minimal — project + agent + optional title; the
// session inherits everything else from the project's defaults. If the
// user has no projects yet (or wants a new one for this session), the
// "+ New project" button opens the same DirectoryPicker the sidebar uses
// and lets them assign the new project to a group (defaults to Ungrouped).
function NewSessionForm({
  projects,
  projectGroups,
  onCancel,
  onCreated,
  onProjectCreated,
}: NewSessionFormProps) {
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
  // Two-step "+ New project" mini-flow: clicking the button reveals a
  // group select and a "Pick directory…" button. We don't open the
  // DirectoryPicker until the user confirms group choice so they can't
  // forget it.
  const [creatingProject, setCreatingProject] = useState(false);
  // null = Ungrouped. Persisted across the DirectoryPicker round-trip so
  // the user picks the group BEFORE the directory and we apply it after.
  const [newProjectGroupId, setNewProjectGroupId] = useState<string | null>(
    null,
  );

  const sortedGroups = useMemo(
    () => [...projectGroups].sort((a, b) => a.orderIndex - b.orderIndex),
    [projectGroups],
  );

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
      const created = await api.createProject({
        name,
        cwd,
        groupId: newProjectGroupId,
      });
      setLocalProjects((prev) => [created, ...prev]);
      setProjectId(created.id);
      setCreatingProject(false);
      setNewProjectGroupId(null);
      onProjectCreated?.(created);
      // Notify AppShell so its sidebar refetches the project list.
      window.dispatchEvent(new CustomEvent('pinloom:projects-changed'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Reusable: group select + "Pick directory…" button. Both the empty-
  // state panel and the regular form's "+ New project" use this so the
  // group decision is made consistently before the picker opens.
  const newProjectControls = (
    <div className="space-y-2">
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
          Group <span className="text-[10px]">(optional)</span>
        </label>
        <select
          value={newProjectGroupId ?? ''}
          onChange={(e) => setNewProjectGroupId(e.target.value || null)}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs"
        >
          <option value="">Ungrouped</option>
          {sortedGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  // Empty state: no projects exist yet → show a CTA panel with group +
  // pick directory.
  if (sortedProjects.length === 0) {
    return (
      <>
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2.5 text-xs">
          <p className="text-[var(--color-ink-muted)]">
            No projects yet. Pick a directory to start one — pinloom uses it as
            the session's working directory.
          </p>
          {newProjectControls}
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
          {!creatingProject && (
            <button
              type="button"
              onClick={() => setCreatingProject(true)}
              title="Create new project"
              aria-label="Create new project"
              className="rounded border border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center gap-1"
            >
              <Plus size={11} />
              New
            </button>
          )}
        </div>
        {creatingProject && (
          <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 space-y-2 text-xs">
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
              New project
            </p>
            {newProjectControls}
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setCreatingProject(false);
                  setNewProjectGroupId(null);
                }}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Cancel
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
        )}
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
