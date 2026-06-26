import { Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '@pinloom/shared';

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
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Analyze project for conventions"
        className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ maxHeight: 'min(640px, 85vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles size={13} className="text-[var(--color-accent)]" />
              Analyze project for conventions
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
              An AI agent reads the project read-only and writes
              <span className="font-mono"> conventions-&lt;slug&gt;.md</span>. “Auto”
              re-analyzes in the background as work accrues and stages the result
              as a proposal you review under Proposals.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close analyze picker"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {projects.length === 0 && (
            <div className="px-4 py-6 text-xs text-[var(--color-ink-muted)] text-center">
              No projects registered.
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
                  title="Auto-analyze this project in the background (stages a proposal to review)"
                >
                  <input
                    type="checkbox"
                    checked={p.wikiAuto}
                    onChange={(e) => onToggleAuto(p, e.target.checked)}
                  />
                  Auto
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
                      <Loader2 size={12} className="animate-spin" /> Analyzing…
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} /> Analyze now
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
