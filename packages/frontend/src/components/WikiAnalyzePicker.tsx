import { useEffect, useState } from 'react';
import { Activity, Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useT } from '../i18n/t.js';

interface Props {
  projects: Project[];
  runningProjectIds: Set<string>;
  onAnalyze: (project: Project) => void;
  onToggleAuto: (project: Project, auto: boolean) => void;
  onClose: () => void;
}

export function WikiAnalyzePicker({
  projects,
  runningProjectIds,
  onAnalyze,
  onToggleAuto,
  onClose,
}: Props) {
  const t = useT();
  const [activity, setActivity] = useState<Awaited<
    ReturnType<typeof api.getWikiActivity>
  > | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getWikiActivity()
        .then((a) => alive && setActivity(a))
        .catch(() => {});
    load();
    const id = setInterval(load, 3000); // background work is invisible otherwise
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const analyzing = activity?.analyzing.running ?? [];
  const syncing = activity?.syncing.running ?? [];
  const anyRunning = analyzing.length + syncing.length > 0;
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('cmp.wikiAnalyze.title')}
        className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ maxHeight: 'min(640px, 85vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles size={13} className="text-[var(--color-accent)]" />
              {t('cmp.wikiAnalyze.title')}
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
              {t('cmp.wikiAnalyze.desc')}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('cmp.wikiAnalyze.close')}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-ink-muted)]">
            {anyRunning ? (
              <Loader2 size={11} className="animate-spin text-[var(--color-accent)]" />
            ) : (
              <Activity size={11} />
            )}
            {anyRunning ? t('cmp.wikiAnalyze.inProgress') : t('cmp.wikiAnalyze.activity')}
          </div>
          {!anyRunning ? (
            <div className="text-[11px] text-[var(--color-ink-muted)]">
              {t('cmp.wikiAnalyze.idleHint')}
            </div>
          ) : (
            <div className="space-y-1">
              {analyzing.map((e) => (
                <div key={`a-${e.projectId}`} className="truncate text-[11px] text-[var(--color-ink)]">
                  <span className="text-[var(--color-accent)]">
                    {t('cmp.wikiAnalyze.analyzingLabel')}
                  </span>{' '}
                  · {e.projectName}
                </div>
              ))}
              {syncing.map((e) => (
                <div key={`s-${e.sessionId}`} className="truncate text-[11px] text-[var(--color-ink)]">
                  <span className="text-[var(--color-accent)]">
                    {t('cmp.wikiAnalyze.syncingLabel')}
                  </span>{' '}
                  · {e.projectName}
                  {e.sessionTitle ? ` — ${e.sessionTitle}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {projects.length === 0 && (
            <div className="px-4 py-6 text-xs text-[var(--color-ink-muted)] text-center">
              {t('cmp.wikiAnalyze.noProjects')}
            </div>
          )}
          {projects.map((p) => {
            const running = runningProjectIds.has(p.id);
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {p.cwd}
                  </div>
                </div>
                <label
                  className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-[var(--color-ink-muted)]"
                  title={t('cmp.wikiAnalyze.autoTooltip')}
                >
                  <input
                    type="checkbox"
                    checked={p.wikiAuto}
                    onChange={(e) => onToggleAuto(p, e.target.checked)}
                  />
                  {t('cmp.wikiAnalyze.auto')}
                </label>
                <button
                  onClick={() => {
                    if (running) return;
                    onAnalyze(p);
                    onClose();
                  }}
                  disabled={running}
                  className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {running ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> {t('cmp.wikiAnalyze.analyzing')}
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} /> {t('cmp.wikiAnalyze.analyzeNow')}
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
