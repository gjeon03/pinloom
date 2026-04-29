import { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api, type WikiAnalyzeResult } from '../api/client.js';

interface Props {
  projects: Project[];
  onClose: () => void;
  onAnalyzed: (project: Project, result: WikiAnalyzeResult) => void;
}

export function WikiAnalyzePicker({ projects, onClose, onAnalyzed }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyzeOne(p: Project) {
    setBusyId(p.id);
    setError(null);
    try {
      const result = await api.wikiAnalyze({
        projectId: p.id,
        dimension: 'conventions',
      });
      setDoneId(p.id);
      onAnalyzed(p, result);
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

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
              An AI agent will read the project read-only and produce a
              \`conventions-{'<slug>'}.md\` page.
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
            const busy = busyId === p.id;
            const done = doneId === p.id;
            const disabled = !!busyId || done;
            return (
              <button
                key={p.id}
                onClick={() => !disabled && analyzeOne(p)}
                disabled={disabled}
                className="w-full text-left px-4 py-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-3)] disabled:opacity-60 flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="mt-0.5 text-[11px] font-mono text-[var(--color-ink-muted)] truncate">
                    {p.cwd}
                  </div>
                </div>
                <div className="shrink-0 mt-1">
                  {busy ? (
                    <Loader2
                      size={14}
                      className="animate-spin text-[var(--color-accent)]"
                    />
                  ) : done ? (
                    <Check size={14} className="text-emerald-500" />
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {busyId && (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-3)] px-4 py-2 text-[11px] text-[var(--color-ink-muted)]">
            Analyzing… this may take 30s–2min depending on project size.
          </div>
        )}
        {error && (
          <div className="border-t border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-4 py-2 text-[11px] text-[var(--color-error-ink)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
