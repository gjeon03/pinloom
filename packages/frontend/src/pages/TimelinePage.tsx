import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { CalendarDays, ChevronDown, FolderOpen, Pencil, RefreshCw, Save, X, ChevronRight } from 'lucide-react';
import { api } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';
import { useT } from '../i18n/t.js';

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    // ignore
  }
}

// L1 Work Timeline reader (knowledge-system-v3 Phase 3). "By project" is a
// macOS-Finder column view: projects | the selected project's dates | the
// entry. "By date" shows every project's entry for one day. Plus the
// per-project auto-capture toggle and manual capture (one project / all).
export function TimelinePage() {
  const t = useT();
  const [mode, setMode] = useState<'project' | 'date'>('project');
  const [projectId, setProjectIdRaw] = useState<string | null>(() => load('pinloom:timeline:project'));
  const [projDate, setProjDateRaw] = useState<string | null>(() => load('pinloom:timeline:date'));
  const [date, setDate] = useState<string>(localToday());
  // Which day Capture now / Capture all target (default today; pick a past day
  // to backfill a date the auto-sweep hasn't reached yet, or regenerate one).
  const [captureDate, setCaptureDate] = useState<string>(localToday());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function setProjectId(id: string) {
    setProjectIdRaw(id);
    save('pinloom:timeline:project', id);
  }
  function setProjDate(d: string) {
    setProjDateRaw(d);
    save('pinloom:timeline:date', d);
  }

  const { data: index } = useSWR('timeline:index', () => api.getTimelineIndex());
  const projects = index?.projects ?? [];
  const { data: groups = [] } = useSWR('timeline:groups', () => api.listProjectGroups());

  // Column 1 grouped like the sidebar (named groups by order → Ungrouped), each
  // collapsible. Collapsed keys persist so the choice sticks across reloads.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('pinloom:timelineCollapsedGroups') ?? '[]'));
    } catch {
      return new Set();
    }
  });
  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem('pinloom:timelineCollapsedGroups', JSON.stringify([...next]));
      return next;
    });
  }
  const groupedProjects = useMemo(() => {
    const byGroup = new Map<string | null, typeof projects>();
    for (const p of projects) {
      const arr = byGroup.get(p.groupId) ?? [];
      arr.push(p);
      byGroup.set(p.groupId, arr);
    }
    const out: { key: string; label: string; isUngrouped: boolean; items: typeof projects }[] = [];
    for (const g of [...groups].sort((a, b) => a.orderIndex - b.orderIndex)) {
      const ps = byGroup.get(g.id);
      if (ps?.length) out.push({ key: g.id, label: g.name, isUngrouped: false, items: ps });
    }
    const ung = byGroup.get(null);
    if (ung?.length) out.push({ key: '__ung__', label: t('page.timeline.ungrouped'), isUngrouped: true, items: ung });
    return out;
  }, [projects, groups, t]);

  // Group-scope filter for the project column. '' = all groups.
  const [filterGroupId, setFilterGroupId] = useState('');
  const visibleSections = useMemo(() => {
    if (!filterGroupId) return groupedProjects;
    return groupedProjects.filter((sec) =>
      filterGroupId === '__ungrouped__' ? sec.isUngrouped : sec.key === filterGroupId,
    );
  }, [groupedProjects, filterGroupId]);

  const selected = useMemo(
    () => projects.find((p) => p.projectId === projectId) ?? null,
    [projects, projectId],
  );

  // Default to the first project + its newest date once the index loads (or
  // after the persisted project disappears / its date is gone).
  useEffect(() => {
    if (projects.length === 0) return;
    let pid = projectId;
    if (!pid || !projects.some((p) => p.projectId === pid)) {
      pid = (projects.find((p) => p.dates.length > 0) ?? projects[0]).projectId;
      setProjectId(pid);
    }
    const proj = projects.find((p) => p.projectId === pid);
    if (proj && (!projDate || !proj.dates.includes(projDate)) && proj.dates.length > 0) {
      setProjDate(proj.dates[0]);
    }
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only fetch when the selected project actually has this date — avoids a 404
  // on a stale persisted date that the current project no longer has.
  const { data: entry } = useSWR(
    mode === 'project' && projectId && projDate && selected?.dates.includes(projDate)
      ? ['timeline:entry', projectId, projDate]
      : null,
    () => api.getTimelineEntry(projectId as string, projDate as string),
  );

  const { data: globalData } = useSWR(
    mode === 'date' && date ? ['timeline:date', date] : null,
    () => api.getTimelineForDate(date),
  );

  // In-place edit of the current project-day entry (mirrors the wiki's edit).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);
  // Leave edit mode whenever the viewed entry changes (project/date switch).
  useEffect(() => {
    setEditing(false);
  }, [projectId, projDate]);

  function startEditEntry() {
    setDraft(entry?.markdown ?? '');
    setEditing(true);
  }
  async function saveEntry() {
    if (!projectId || !projDate) return;
    setSavingEntry(true);
    try {
      await api.saveTimelineEntry(projectId, projDate, draft);
      await globalMutate(['timeline:entry', projectId, projDate]);
      setEditing(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEntry(false);
    }
  }
  async function openEntryFile() {
    if (!projectId || !projDate) return;
    try {
      await api.openTimelineInEditor(projectId, projDate);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // "Capture all" runs as a backend job; poll its status so progress survives
  // navigation AND reload (the backend owns the state). Poll only while running.
  const { data: capJob } = useSWR('timeline:capture-status', () => api.captureAllStatus(), {
    refreshInterval: (d) => (d?.running ? 1500 : 0),
  });
  const capturingAll = capJob?.running ?? false;
  // When a capture-all finishes, refresh the timeline views.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && capJob && !capJob.running) {
      void globalMutate('timeline:index');
      if (capJob.date) void globalMutate(['timeline:date', capJob.date]);
      if (projectId && capJob.date) void globalMutate(['timeline:entry', projectId, capJob.date]);
      setNotice(t('page.timeline.capturedProjects', { captured: capJob.captured, total: capJob.total }));
      setTimeout(() => setNotice(null), 6000);
    }
    wasRunning.current = capJob?.running ?? false;
  }, [capJob?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click a project → select it + jump to its newest date (Finder fills the
  // next column). Keep the current date if the project still has it.
  function clickProject(pid: string) {
    setProjectId(pid);
    const proj = projects.find((p) => p.projectId === pid);
    if (proj && proj.dates.length > 0 && (!projDate || !proj.dates.includes(projDate))) {
      setProjDate(proj.dates[0]);
    }
  }

  async function toggleAuto() {
    if (!selected) return;
    await api.setProjectTimelineAuto(selected.projectId, !selected.auto);
    void globalMutate('timeline:index');
  }

  async function captureNow() {
    if (!projectId || busy) return;
    setBusy(true);
    setNotice(t('page.timeline.capturing'));
    try {
      const r = await api.captureTimeline(projectId, captureDate);
      setNotice(r.written ? t('page.timeline.capturedDate', { date: r.date }) : t('page.timeline.nothingToCapture'));
      void globalMutate('timeline:index');
      void globalMutate(['timeline:entry', projectId, r.date]);
      if (r.written) setProjDate(r.date);
    } catch (e) {
      setNotice(t('page.timeline.failed', { error: String(e) }));
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 4000);
    }
  }

  async function captureAll() {
    if (capturingAll) return;
    try {
      await api.captureTimelineAll(captureDate);
      void globalMutate('timeline:capture-status'); // kick off polling immediately
    } catch (e) {
      setNotice(t('page.timeline.failed', { error: String(e) }));
      setTimeout(() => setNotice(null), 4000);
    }
  }

  const captureBtnCls =
    'flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50';

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-[var(--color-border)] pl-4 pr-60 py-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays size={16} /> {t('page.timeline.title')}
        </div>
        <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
          <button
            onClick={() => setMode('project')}
            title={t('page.timeline.byProjectTooltip')}
            className={`px-2 py-1 ${mode === 'project' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            {t('page.timeline.byProject')}
          </button>
          <button
            onClick={() => setMode('date')}
            title={t('page.timeline.byDateTooltip')}
            className={`px-2 py-1 ${mode === 'date' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            {t('page.timeline.byDate')}
          </button>
        </div>

        {/* LEFT — view controls: what you're looking at */}
        {mode === 'project' && selected && (
          <label
            className="flex items-center gap-1 text-xs text-[var(--color-ink-muted)] cursor-pointer"
            title={t('page.timeline.autoCaptureTooltip', { name: selected.projectName })}
          >
            <input type="checkbox" checked={selected.auto} onChange={() => void toggleAuto()} />
            {t('page.timeline.autoCapture')}
          </label>
        )}
        {mode === 'date' && (
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[var(--color-ink-muted)]">{t('page.timeline.viewing')}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
            />
          </label>
        )}
        {mode === 'project' && groups.length > 0 && (
          <select
            value={filterGroupId}
            onChange={(e) => setFilterGroupId(e.target.value)}
            title={t('page.timeline.filterByGroup')}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink-muted)]"
          >
            <option value="">{t('page.timeline.allGroups')}</option>
            {[...groups]
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            <option value="__ungrouped__">{t('page.timeline.ungrouped')}</option>
          </select>
        )}

        {/* RIGHT — capture controls: target day + actions, grouped + labelled so
            the capture date isn't mistaken for the view date. */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-muted)]">
            {t('page.timeline.capture')}
          </span>
          <input
            type="date"
            value={captureDate}
            max={localToday()}
            title={t('page.timeline.targetDayTooltip')}
            onChange={(e) => setCaptureDate(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-1 text-xs"
          />
          {mode === 'project' && selected && (
            <button
              onClick={() => void captureNow()}
              disabled={busy}
              title={t('page.timeline.captureThisTooltip', { date: captureDate, name: selected.projectName })}
              className={captureBtnCls}
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {t('page.timeline.thisProject')}
            </button>
          )}
          <button
            onClick={() => void captureAll()}
            disabled={busy || capturingAll}
            title={t('page.timeline.captureAllTooltip', { date: captureDate })}
            className={captureBtnCls}
          >
            <RefreshCw size={12} className={capturingAll ? 'animate-spin' : ''} />{' '}
            {capturingAll ? `${capJob!.done}/${capJob!.total}…` : t('page.timeline.allProjects')}
          </button>
          {notice && <span className="text-xs text-[var(--color-ink-muted)]">{notice}</span>}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {mode === 'project' ? (
          <>
            {/* Column 1 — projects, grouped + collapsible (like the sidebar) */}
            <div className="w-52 shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-1">
              {projects.length === 0 ? (
                <div className="text-xs text-[var(--color-ink-muted)] p-3">{t('page.timeline.noProjects')}</div>
              ) : (
                visibleSections.map((sec) => {
                  const open = !collapsedGroups.has(sec.key);
                  return (
                    <div key={sec.key}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(sec.key)}
                        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--color-surface-2)]"
                      >
                        {open ? (
                          <ChevronDown size={11} className="shrink-0 text-[var(--color-ink-muted)]" />
                        ) : (
                          <ChevronRight size={11} className="shrink-0 text-[var(--color-ink-muted)]" />
                        )}
                        <span
                          className={`text-[10px] font-semibold uppercase tracking-wide ${
                            sec.isUngrouped
                              ? 'italic text-[var(--color-ink-muted)]'
                              : 'text-[var(--color-ink)]'
                          }`}
                        >
                          {sec.label}
                        </span>
                        <span className="ml-auto text-[10px] text-[var(--color-ink-muted)]">
                          {sec.items.length}
                        </span>
                      </button>
                      {open &&
                        sec.items.map((p) => {
                          const isSel = p.projectId === projectId;
                          return (
                            <button
                              key={p.projectId}
                              onClick={() => clickProject(p.projectId)}
                              className={`flex w-full items-center gap-2 py-1.5 pl-5 pr-3 text-left text-xs ${
                                isSel
                                  ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                                  : 'text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]'
                              }`}
                            >
                              <span className="flex-1 truncate">{p.projectName}</span>
                              <span className="text-[10px] text-[var(--color-ink-muted)]">
                                {p.dates.length || ''}
                              </span>
                              <ChevronRight
                                size={12}
                                className="shrink-0 text-[var(--color-ink-muted)]"
                              />
                            </button>
                          );
                        })}
                    </div>
                  );
                })
              )}
            </div>
            {/* Column 2 — the selected project's dates */}
            <div className="w-44 shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-1">
              {!selected ? (
                <div className="text-xs text-[var(--color-ink-muted)] p-3">{t('page.timeline.selectProject')}</div>
              ) : selected.dates.length === 0 ? (
                <div className="text-xs text-[var(--color-ink-muted)] p-3">{t('page.timeline.noEntries')}</div>
              ) : (
                selected.dates.map((d) => (
                  <button
                    key={d}
                    onClick={() => setProjDate(d)}
                    className={`block w-full px-3 py-1.5 text-left text-xs ${
                      d === projDate
                        ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]'
                    }`}
                  >
                    {d}
                  </button>
                ))
              )}
            </div>
            {/* Column 3 — the entry (with per-entry edit + open-in-editor) */}
            <div className="flex-1 overflow-y-auto p-4">
              {selected && projDate ? (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {selected.projectName} · {projDate}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {editing ? (
                        <>
                          <button
                            onClick={() => setEditing(false)}
                            disabled={savingEntry}
                            className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
                          >
                            <X size={12} /> {t('page.timeline.cancel')}
                          </button>
                          <button
                            onClick={() => void saveEntry()}
                            disabled={savingEntry}
                            className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-black disabled:opacity-50"
                          >
                            <Save size={12} /> {savingEntry ? t('page.timeline.saving') : t('page.timeline.save')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={startEditEntry}
                            title={t('page.timeline.editTooltip')}
                            className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
                          >
                            <Pencil size={12} /> {t('page.timeline.edit')}
                          </button>
                          <button
                            onClick={() => void openEntryFile()}
                            disabled={!entry?.markdown}
                            title={t('page.timeline.revealTooltip')}
                            className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
                          >
                            <FolderOpen size={12} /> {t('page.timeline.reveal')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {editing ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      className="h-[calc(100%-2.5rem)] min-h-64 w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 font-mono text-xs leading-relaxed"
                      placeholder={t('page.timeline.entryPlaceholder')}
                    />
                  ) : entry?.markdown ? (
                    <Markdown content={entry.markdown} />
                  ) : (
                    <div className="text-sm text-[var(--color-ink-muted)]">
                      {t('page.timeline.noEntryForDay')} <span className="text-[var(--color-ink-muted)]">{t('page.timeline.clickEditToWrite')}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-[var(--color-ink-muted)]">{t('page.timeline.pickDate')}</div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {(globalData?.entries ?? []).length === 0 ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                {t('page.timeline.noWorkOnDate', { date })}
              </div>
            ) : (
              globalData!.entries.map((e) => (
                <section key={e.slug}>
                  <div className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
                    {e.projectName}
                  </div>
                  <Markdown content={e.markdown} />
                </section>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
