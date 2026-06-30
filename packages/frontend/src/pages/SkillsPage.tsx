import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Save, Link2, Eye, Pencil, RefreshCw } from 'lucide-react';
import { api, type SkillScope, type SkillSummary, type SkillDetail, type SkillOrigin } from '../api/client.js';
import type { Project } from '@pinloom/shared';
import { Markdown } from '../components/Markdown.js';
import { useT } from '../i18n/t.js';

// Skills management page. Skills are a single source (~/.pinloom/skills,
// symlinked into ~/.claude + ~/.codex so both agents see them) or project-scoped
// (<cwd>/.claude/skills, version-controlled). This page lists / edits / deletes
// them and repairs the claude/codex links; NEW skills are authored via the AI
// skill bot (the "Create with AI" button) which this page then manages.
export function SkillsPage() {
  const t = useT();
  const navigate = useNavigate();
  const [scope, setScope] = useState<SkillScope>('global');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [desc, setDesc] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  const loadList = useCallback(() => {
    setLoading(true);
    setError(null);
    const pid = scope === 'project' ? projectId : undefined;
    if (scope === 'project' && !pid) {
      setSkills([]);
      setLoading(false);
      return;
    }
    api
      .listSkills(scope, pid)
      .then((s) => setSkills(s))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [scope, projectId]);
  useEffect(loadList, [loadList]);

  // Clear the open editor when the scope/project changes (its skill may not exist there).
  useEffect(() => {
    setSelected(null);
    setDetail(null);
  }, [scope, projectId]);

  const dirty = detail != null && (desc !== detail.description || body !== detail.body);
  // external / local global skills are owned elsewhere — view only.
  const readOnly = detail?.editable === false;

  async function open(name: string) {
    setSelected(name);
    setError(null);
    try {
      const d = await api.getSkill(scope, name, scope === 'project' ? projectId : undefined);
      setDetail(d);
      setDesc(d.description);
      setBody(d.body);
      setPreview(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveSkill({
        name: detail.name,
        scope,
        description: desc,
        body,
        project: scope === 'project' ? projectId : undefined,
      });
      loadList();
      await open(detail.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    if (!window.confirm(t('cmp.skills.deleteConfirm', { name: detail.name }))) return;
    setBusy(true);
    try {
      await api.deleteSkill(scope, detail.name, scope === 'project' ? projectId : undefined);
      setSelected(null);
      setDetail(null);
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function relink() {
    if (!detail) return;
    setBusy(true);
    try {
      await api.relinkSkill(detail.name);
      loadList();
      await open(detail.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createWithAi() {
    try {
      const s = await api.openBot('skill');
      navigate(`/s/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const tab = (s: SkillScope, label: string) => (
    <button
      type="button"
      onClick={() => setScope(s)}
      className={`rounded-md px-3 py-1 text-xs ${
        scope === s
          ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
      }`}
    >
      {label}
    </button>
  );

  // Static t() calls (no template-literal keys) so the i18n guard can verify them.
  const originLabel = (o: SkillOrigin) =>
    o === 'pinloom'
      ? t('cmp.skills.origin.pinloom')
      : o === 'external'
        ? t('cmp.skills.origin.external')
        : t('cmp.skills.origin.local');

  const originTag = (origin?: SkillOrigin) => {
    if (!origin) return null;
    const cls =
      origin === 'pinloom'
        ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
        : 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]';
    return <span className={`rounded px-1 text-[10px] ${cls}`}>{originLabel(origin)}</span>;
  };

  // For pinloom-managed skills the agent badge reflects LINK HEALTH (✓ / ✗
  // repairable); for external/local it's just presence.
  const agentTag = (s: SkillSummary, label: 'claude' | 'codex') => {
    const present = label === 'claude' ? s.hasClaude : s.hasCodex;
    if (!present) return null;
    const linked = label === 'claude' ? s.linkedClaude : s.linkedCodex;
    const broken = s.origin === 'pinloom' && linked === false;
    return (
      <span
        className={`rounded px-1 text-[10px] ${
          broken ? 'bg-red-500/15 text-red-400' : 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]'
        }`}
        title={broken ? `${label} not linked — relink` : `${label}`}
      >
        {label}
        {broken ? ' ✗' : ''}
      </span>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
        <h1 className="text-sm font-semibold">{t('cmp.skills.title')}</h1>
        <div className="flex items-center gap-1">
          {tab('global', t('cmp.skills.scope.global'))}
          {tab('project', t('cmp.skills.scope.project'))}
        </div>
        {scope === 'project' && (
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink)]"
          >
            <option value="">{t('cmp.skills.pickProject')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={createWithAi}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
        >
          <Plus size={14} />
          {t('cmp.skills.createWithAi')}
        </button>
      </header>

      {error && <p className="border-b border-[var(--color-border)] px-4 py-1.5 text-xs text-red-400">{error}</p>}

      <div className="flex min-h-0 flex-1">
        {/* List */}
        <div className="w-64 shrink-0 overflow-auto border-r border-[var(--color-border)] py-2">
          {loading ? (
            <p className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">{t('cmp.skills.loading')}</p>
          ) : skills.length === 0 ? (
            <p className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">
              {scope === 'project' && !projectId ? t('cmp.skills.pickProject') : t('cmp.skills.empty')}
            </p>
          ) : (
            skills.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => open(s.name)}
                className={`block w-full px-4 py-2 text-left ${
                  selected === s.name ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-2)]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-[var(--color-ink)]">{s.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {!!s.useCount && (
                      <span
                        className="rounded px-1 text-[10px] text-[var(--color-ink-muted)]"
                        title={t('cmp.skills.usedTimes', { n: String(s.useCount) })}
                      >
                        🔥 {s.useCount}
                      </span>
                    )}
                    {s.scope === 'global' && (
                      <>
                        {originTag(s.origin)}
                        {agentTag(s, 'claude')}
                        {agentTag(s, 'codex')}
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-ink-muted)]">{s.description}</p>
              </button>
            ))
          )}
        </div>

        {/* Editor */}
        <div className="min-h-0 flex-1 overflow-auto">
          {!detail ? (
            <p className="px-6 py-6 text-sm text-[var(--color-ink-muted)]">{t('cmp.skills.selectHint')}</p>
          ) : (
            <div className="flex flex-col gap-3 px-6 py-4">
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-sm font-semibold text-[var(--color-ink)]">{detail.name}</h2>
                {!!detail.useCount && (
                  <span className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ink-muted)]">
                    🔥 {t('cmp.skills.usedTimes', { n: String(detail.useCount) })}
                  </span>
                )}
                {!readOnly && scope === 'global' && (detail.linkedClaude === false || detail.linkedCodex === false) && (
                  <button
                    type="button"
                    onClick={relink}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)]"
                  >
                    <Link2 size={12} />
                    {t('cmp.skills.relink')}
                  </button>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPreview((p) => !p)}
                    className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-accent)]"
                  >
                    {preview ? <Pencil size={12} /> : <Eye size={12} />}
                    {preview ? t('cmp.skills.edit') : t('cmp.skills.preview')}
                  </button>
                  {!readOnly && (
                    <>
                      <button
                        type="button"
                        onClick={save}
                        disabled={busy || !dirty}
                        className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)] disabled:opacity-40"
                      >
                        {busy ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
                        {t('cmp.skills.save')}
                      </button>
                      <button
                        type="button"
                        onClick={remove}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-red-400 hover:border-red-400 disabled:opacity-40"
                      >
                        <Trash2 size={12} />
                        {t('cmp.skills.delete')}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {readOnly && (
                <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
                  {detail.origin === 'external'
                    ? t('cmp.skills.readonly.external')
                    : t('cmp.skills.readonly.local')}
                  {detail.target ? ` — ${detail.target}` : ''}
                </p>
              )}

              <label className="text-xs text-[var(--color-ink-muted)]">
                {t('cmp.skills.description')}
                <input
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  readOnly={readOnly}
                  className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm text-[var(--color-ink)] read-only:opacity-70"
                />
              </label>

              {preview ? (
                <div className="rounded-md border border-[var(--color-border)] px-3 py-2">
                  <Markdown content={body} />
                </div>
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  readOnly={readOnly}
                  spellCheck={false}
                  className="min-h-[50vh] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs text-[var(--color-ink)] read-only:opacity-70"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
