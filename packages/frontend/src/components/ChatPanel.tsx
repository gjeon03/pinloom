import { useState } from 'react';
import type { Plan, PlanItem, Project } from '@planloom/shared';

interface Props {
  project: Project;
  activePlan: Plan | null;
  items: PlanItem[];
}

export function ChatPanel({ project, activePlan, items }: Props) {
  const [input, setInput] = useState('');

  return (
    <section className="flex flex-col min-h-0 bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-ink-muted)]">
        Chat · {activePlan ? activePlan.title : 'no plan selected'}
      </header>

      <div className="flex-1 overflow-auto p-4 text-sm text-[var(--color-ink-muted)]">
        <p>
          Chat stream and AI runner will land here. Messages will be persisted to the local
          SQLite DB and tagged to plan items via <code className="text-[var(--color-accent)]">@item-id</code>.
        </p>
        {items.length > 0 && (
          <p className="mt-2 text-xs">
            Current plan has {items.length} item{items.length === 1 ? '' : 's'}.
          </p>
        )}
        <p className="mt-2 text-xs">Project cwd: <code className="font-mono">{project.cwd}</code></p>
      </div>

      <form
        className="border-t border-[var(--color-border)] p-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setInput('');
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={activePlan ? 'Message the plan…' : 'Create a plan first'}
          disabled={!activePlan}
          className="flex-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!activePlan || !input.trim()}
          className="rounded bg-[var(--color-accent)] text-black px-4 py-2 text-sm disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
