import type { Project } from '@planloom/shared';

export function TerminalPanel({ project }: { project: Project }) {
  return (
    <aside className="border-l border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
      <header className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">
        Run logs
      </header>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs text-[var(--color-ink-muted)]">
        <p>
          Streaming stdout/stderr from the AI runner will appear here, scoped to <code>{project.name}</code>.
        </p>
      </div>
    </aside>
  );
}
