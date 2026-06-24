import { useEffect, useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { CalendarDays, RefreshCw, ChevronRight } from 'lucide-react';
import { api } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';

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

// L1 Work Timeline reader (knowledge-system-v3 Phase 3). "By project" shows a
// Finder-style tree (project → its dated entries) in the left sidebar; "By
// date" shows every project's entry for one day. Plus the per-project
// auto-capture toggle and manual capture (one project / all).
export function TimelinePage() {
  const [mode, setMode] = useState<'project' | 'date'>('project');
  const [projectId, setProjectIdRaw] = useState<string | null>(() => load('pinloom:timeline:project'));
  const [projDate, setProjDateRaw] = useState<string | null>(() => load('pinloom:timeline:date'));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [date, setDate] = useState<string>(localToday());
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

  const selected = useMemo(
    () => projects.find((p) => p.projectId === projectId) ?? null,
    [projects, projectId],
  );

  // Pick a sensible default project + date once the index loads (or after the
  // persisted project disappears), and keep the chosen project expanded.
  useEffect(() => {
    if (projects.length === 0) return;
    let pid = projectId;
    if (!pid || !projects.some((p) => p.projectId === pid)) {
      pid = (projects.find((p) => p.dates.length > 0) ?? projects[0]).projectId;
      setProjectId(pid);
    }
    setExpanded((prev) => new Set(prev).add(pid as string));
    const proj = projects.find((p) => p.projectId === pid);
    if (proj && (!projDate || !proj.dates.includes(projDate)) && proj.dates.length > 0) {
      setProjDate(proj.dates[0]);
    }
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: entry } = useSWR(
    mode === 'project' && projectId && projDate
      ? ['timeline:entry', projectId, projDate]
      : null,
    () => api.getTimelineEntry(projectId as string, projDate as string),
  );

  const { data: globalData } = useSWR(
    mode === 'date' && date ? ['timeline:date', date] : null,
    () => api.getTimelineForDate(date),
  );

  function clickProject(pid: string) {
    setProjectId(pid);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
    const proj = projects.find((p) => p.projectId === pid);
    if (proj && proj.dates.length > 0 && (!projDate || !proj.dates.includes(projDate))) {
      setProjDate(proj.dates[0]);
    }
  }
  function clickDate(pid: string, d: string) {
    setProjectId(pid);
    setProjDate(d);
  }

  async function toggleAuto() {
    if (!selected) return;
    await api.setProjectTimelineAuto(selected.projectId, !selected.auto);
    void globalMutate('timeline:index');
  }

  async function captureNow() {
    if (!projectId || busy) return;
    setBusy(true);
    setNotice('Capturing…');
    try {
      const r = await api.captureTimeline(projectId);
      setNotice(r.written ? `Captured ${r.date}` : 'Nothing new to capture');
      void globalMutate('timeline:index');
      void globalMutate(['timeline:entry', projectId, r.date]);
      if (r.written) setProjDate(r.date);
    } catch (e) {
      setNotice(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 4000);
    }
  }

  async function captureAll() {
    if (busy) return;
    setBusy(true);
    setNotice('Capturing all projects… (takes a while)');
    try {
      const r = await api.captureTimelineAll();
      setNotice(`Captured ${r.captured}/${r.projects} projects`);
      void globalMutate('timeline:index');
      void globalMutate(['timeline:date', r.date]);
      if (projectId) void globalMutate(['timeline:entry', projectId, r.date]);
    } catch (e) {
      setNotice(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }

  const captureBtnCls =
    'flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50';

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays size={16} /> Work Timeline
        </div>
        <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
          <button
            onClick={() => setMode('project')}
            className={`px-2 py-1 ${mode === 'project' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            By project
          </button>
          <button
            onClick={() => setMode('date')}
            className={`px-2 py-1 ${mode === 'date' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            By date (all)
          </button>
        </div>

        {mode === 'project' && selected && (
          <>
            <label className="flex items-center gap-1 text-xs text-[var(--color-ink-muted)]">
              <input type="checkbox" checked={selected.auto} onChange={() => void toggleAuto()} />
              Auto-capture
            </label>
            <button
              onClick={() => void captureNow()}
              disabled={busy}
              title={`Capture today's work for ${selected.projectName}`}
              className={captureBtnCls}
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Capture now
            </button>
          </>
        )}
        {mode === 'date' && (
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
          />
        )}
        <button
          onClick={() => void captureAll()}
          disabled={busy}
          title="Capture today's work for every project"
          className={captureBtnCls}
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Capture all
        </button>
        {notice && <span className="text-xs text-[var(--color-ink-muted)]">{notice}</span>}
      </header>

      <div className="flex-1 min-h-0 flex">
        {mode === 'project' ? (
          <>
            {/* Finder-style project → date tree */}
            <div className="w-56 shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-1">
              {projects.length === 0 ? (
                <div className="text-xs text-[var(--color-ink-muted)] p-3">No projects.</div>
              ) : (
                projects.map((p) => {
                  const isOpen = expanded.has(p.projectId);
                  const isSel = p.projectId === projectId;
                  return (
                    <div key={p.projectId}>
                      <button
                        onClick={() => clickProject(p.projectId)}
                        className={`flex w-full items-center gap-1 px-2 py-1 text-left text-xs ${
                          isSel && !projDate
                            ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                            : 'text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]'
                        }`}
                      >
                        <ChevronRight
                          size={12}
                          className={`shrink-0 transition-transform text-[var(--color-ink-muted)] ${isOpen ? 'rotate-90' : ''}`}
                        />
                        <span className="truncate flex-1">{p.projectName}</span>
                        <span className="text-[10px] text-[var(--color-ink-muted)]">
                          {p.dates.length || ''}
                        </span>
                      </button>
                      {isOpen &&
                        (p.dates.length === 0 ? (
                          <div className="pl-7 pr-2 py-1 text-[11px] text-[var(--color-ink-muted)] italic">
                            no entries
                          </div>
                        ) : (
                          p.dates.map((d) => (
                            <button
                              key={d}
                              onClick={() => clickDate(p.projectId, d)}
                              className={`block w-full pl-7 pr-2 py-1 text-left text-xs ${
                                isSel && d === projDate
                                  ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]'
                              }`}
                            >
                              {d}
                            </button>
                          ))
                        ))}
                    </div>
                  );
                })
              )}
            </div>
            {/* Entry */}
            <div className="flex-1 overflow-y-auto p-4">
              {entry?.markdown ? (
                <Markdown content={entry.markdown} />
              ) : (
                <div className="text-sm text-[var(--color-ink-muted)]">
                  {selected && projDate
                    ? 'No entry for this day.'
                    : 'Select a project and date on the left.'}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {(globalData?.entries ?? []).length === 0 ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                No work recorded on {date}.
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
