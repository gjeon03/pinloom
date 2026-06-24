import { useEffect, useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { CalendarDays, RefreshCw } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// L1 Work Timeline reader (knowledge-system-v3 Phase 3). Per-project dated
// journal entries (auto-distilled from sessions + commits) + a cross-project
// "what did I do on D" view, the per-project auto-capture toggle, and a manual
// "capture now" trigger.
export function TimelinePage() {
  const [mode, setMode] = useState<'project' | 'date'>('project');
  // Persist the selected project so it survives navigating away and back (FIX4).
  const [projectId, setProjectIdRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem('pinloom:timeline:project');
    } catch {
      return null;
    }
  });
  function setProjectId(id: string) {
    setProjectIdRaw(id);
    try {
      localStorage.setItem('pinloom:timeline:project', id);
    } catch {
      // ignore
    }
  }
  const [date, setDate] = useState<string>(localToday());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: projects } = useSWR('timeline:projects', () => api.listProjects());

  // Select the first project if none persisted, or the persisted one is gone.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps

  const project = useMemo(
    () => projects?.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const { data: datesData } = useSWR(
    mode === 'project' && projectId ? ['timeline:dates', projectId] : null,
    () => api.listTimelineDates(projectId as string),
  );
  const dates = datesData?.dates ?? [];

  // selected date within project mode (default newest)
  const [projDate, setProjDate] = useState<string | null>(null);
  useEffect(() => {
    setProjDate(dates.length > 0 ? dates[0] : null);
  }, [datesData]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function toggleAuto(p: Project) {
    await api.setProjectTimelineAuto(p.id, !p.timelineAuto);
    void globalMutate('timeline:projects');
  }

  async function captureNow() {
    if (!projectId || busy) return;
    setBusy(true);
    setNotice('정리 중…');
    try {
      const r = await api.captureTimeline(projectId);
      setNotice(r.written ? `${r.date} 정리 완료` : '새로 정리할 내용이 없어요');
      void globalMutate(['timeline:dates', projectId]);
      void globalMutate(['timeline:entry', projectId, r.date]);
    } catch (e) {
      setNotice(`실패: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 4000);
    }
  }

  async function captureAll() {
    if (busy) return;
    setBusy(true);
    setNotice('전체 정리 중… (프로젝트마다 시간이 걸려요)');
    try {
      const r = await api.captureTimelineAll();
      setNotice(`전체 정리 완료 — ${r.captured}/${r.projects} 프로젝트`);
      if (projectId) {
        void globalMutate(['timeline:dates', projectId]);
        void globalMutate(['timeline:entry', projectId, r.date]);
      }
      void globalMutate(['timeline:date', r.date]);
    } catch (e) {
      setNotice(`실패: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays size={16} /> 작업 타임라인
        </div>
        <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
          <button
            onClick={() => setMode('project')}
            className={`px-2 py-1 ${mode === 'project' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            프로젝트별
          </button>
          <button
            onClick={() => setMode('date')}
            className={`px-2 py-1 ${mode === 'date' ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            날짜별(전체)
          </button>
        </div>

        {mode === 'project' && (
          <>
            <select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value)}
              className="text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
            >
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {project && (
              <label className="flex items-center gap-1 text-xs text-[var(--color-ink-muted)]">
                <input
                  type="checkbox"
                  checked={project.timelineAuto}
                  onChange={() => void toggleAuto(project)}
                />
                자동 정리
              </label>
            )}
            <button
              onClick={() => void captureNow()}
              disabled={busy || !projectId}
              title="지금 오늘 작업 정리"
              className="flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50"
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> 지금 정리
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
          title="모든 프로젝트의 오늘 작업을 한 번에 정리"
          className="flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> 전체 정리
        </button>
        {notice && <span className="text-xs text-[var(--color-ink-muted)]">{notice}</span>}
      </header>

      <div className="flex-1 min-h-0 flex">
        {mode === 'project' ? (
          <>
            <div className="w-44 shrink-0 border-r border-[var(--color-border)] overflow-y-auto p-2">
              {dates.length === 0 ? (
                <div className="text-xs text-[var(--color-ink-muted)] p-2">
                  아직 정리된 날이 없어요.
                </div>
              ) : (
                dates.map((d) => (
                  <button
                    key={d}
                    onClick={() => setProjDate(d)}
                    className={`block w-full text-left rounded px-2 py-1 text-xs ${
                      d === projDate
                        ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
                    }`}
                  >
                    {d}
                  </button>
                ))
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {entry?.markdown ? (
                <Markdown content={entry.markdown} />
              ) : (
                <div className="text-sm text-[var(--color-ink-muted)]">
                  {projDate ? '이 날의 엔트리가 없습니다.' : '왼쪽에서 날짜를 선택하세요.'}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {(globalData?.entries ?? []).length === 0 ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                {date}에 정리된 작업이 없습니다.
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
