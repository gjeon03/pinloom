import { Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '@pinloom/shared';

interface Props {
  projects: Project[];
  runningProjectIds: Set<string>;
  onAnalyze: (project: Project) => void;
  onClose: () => void;
}

export function WikiAnalyzePicker({
  projects,
  runningProjectIds,
  onAnalyze,
  onClose,
}: Props) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
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
              <span className="font-mono"> conventions-&lt;slug&gt;.md</span>.
              Runs in the background — track progress in the notification bell.
            </p>
          </div>
          <button
            onClick={onClose}
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
              <button
                key={p.id}
                onClick={() => {
                  if (running) return;
                  onAnalyze(p);
                  onClose();
                }}
                disabled={running}
                className="w-full text-left px-4 py-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="mt-0.5 text-[11px] font-mono text-[var(--color-ink-muted)] truncate">
                    {p.cwd}
                  </div>
                </div>
                <div className="shrink-0 mt-1">
                  {running && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-accent)]">
                      <Loader2 size={12} className="animate-spin" />
                      Analyzing…
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
