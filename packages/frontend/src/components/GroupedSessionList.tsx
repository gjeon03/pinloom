import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Session } from '@pinloom/shared';
import type { GroupSection, ProjectBucket } from '../hooks/useGroupedSessions.js';

// Sidebar-style group → project → session tree for the pickers. The session row
// itself is a render-prop so each picker keeps its own leaf behaviour (select a
// worker / send a pin), while grouping, expand/collapse, counts and the
// "scroll + reveal a just-created session" affordance live here once.
interface Props {
  sections: GroupSection[];
  renderSession: (session: Session, bucket: ProjectBucket) => ReactNode;
  /** Projects expanded on first paint (the rest collapse for scannability). */
  initialExpandedProjectIds?: string[];
  /** When this changes, reveal that session: expand its project + scroll to it. */
  revealSessionId?: string | null;
  loading?: boolean;
  emptyHint?: ReactNode;
}

export function GroupedSessionList({
  sections,
  renderSession,
  initialExpandedProjectIds,
  revealSessionId,
  loading,
  emptyHint,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialExpandedProjectIds ?? []),
  );
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Reveal a freshly-created session: find its project, force it open, then
  // scroll the row into view + let the leaf flash (callers style on revealId).
  useEffect(() => {
    if (!revealSessionId) return;
    const bucket = sections
      .flatMap((s) => s.projects)
      .find((p) => p.sessions.some((s) => s.id === revealSessionId));
    if (bucket) setExpanded((prev) => new Set(prev).add(bucket.project.id));
    const t = setTimeout(() => {
      rowRefs.current.get(revealSessionId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 30);
    return () => clearTimeout(t);
  }, [revealSessionId, sections]);

  const totalSessions = sections.reduce(
    (n, sec) => n + sec.projects.reduce((m, p) => m + p.sessions.length, 0),
    0,
  );

  if (loading) {
    return <p className="px-1 py-2 text-xs text-[var(--color-ink-muted)]">Loading…</p>;
  }
  if (totalSessions === 0) {
    return (
      <div className="px-1 py-2 text-xs text-[var(--color-ink-muted)]">
        {emptyHint ?? 'No sessions.'}
      </div>
    );
  }

  return (
    <div className="max-h-72 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
      {sections.map((sec) => {
        const secCount = sec.projects.reduce((m, p) => m + p.sessions.length, 0);
        if (secCount === 0) return null;
        return (
          <div key={sec.key} className="border-b border-[var(--color-border)] last:border-b-0">
            {sec.label && (
              <div className="flex items-baseline gap-2 bg-[var(--color-surface-2)] px-3 py-1">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide ${
                    sec.isUngrouped ? 'italic text-[var(--color-ink-muted)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {sec.label}
                </span>
                <span className="text-[10px] text-[var(--color-ink-muted)]">{secCount}</span>
              </div>
            )}
            {sec.projects.map((bucket) => {
              if (bucket.sessions.length === 0) return null;
              const open = expanded.has(bucket.project.id);
              return (
                <div key={bucket.project.id}>
                  <button
                    type="button"
                    onClick={() => toggle(bucket.project.id)}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-[var(--color-surface-3)]"
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-[var(--color-ink-muted)]" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-[var(--color-ink-muted)]" />
                    )}
                    <span className="text-[11px] font-medium text-[var(--color-ink)]">
                      {bucket.project.name || '(project)'}
                    </span>
                    {bucket.isCurrent && (
                      <span className="text-[10px] text-[var(--color-accent)]">current</span>
                    )}
                    <span className="ml-auto text-[10px] text-[var(--color-ink-muted)]">
                      {bucket.sessions.length}
                    </span>
                  </button>
                  {open &&
                    bucket.sessions.map((s) => (
                      <div
                        key={s.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(s.id, el);
                          else rowRefs.current.delete(s.id);
                        }}
                        className="pl-4"
                      >
                        {renderSession(s, bucket)}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
