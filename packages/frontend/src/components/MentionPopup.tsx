// Slack-style @-mention popup for the chat composer. Surfaces team
// workers when the user types "@" in an orchestrator session — arrows
// to navigate, Enter/Tab to pick. ChatView wires it via
// `useMentionAutocomplete`; this component is purely presentational.

import { useEffect, useRef } from 'react';
import { AgentBadge } from './AgentBadge.js';
import type { Session, TeamMember } from '@pinloom/shared';

export interface MentionWorker {
  member: TeamMember;
  session: Session | null;
  /** Null when we haven't fetched a label yet (session may have been
   *  deleted, or sessions list hasn't loaded). */
  projectName: string | null;
}

interface Props {
  workers: MentionWorker[];
  highlightIndex: number;
  onPick: (worker: MentionWorker) => void;
  onHover: (index: number) => void;
}

export function MentionPopup({
  workers,
  highlightIndex,
  onPick,
  onHover,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const item = ul.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  if (workers.length === 0) return null;

  return (
    <div
      className="absolute bottom-full mb-1 left-0 z-40 w-72 max-w-[90vw] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
      data-mention-popup
      onMouseDown={(e) => {
        // Prevent the textarea from losing focus when a row is clicked,
        // which would close the popup before onClick fires.
        e.preventDefault();
      }}
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] border-b border-[var(--color-border)]/40">
        Mention worker
      </div>
      <ul ref={listRef} className="max-h-60 overflow-y-auto py-1">
        {workers.map((w, i) => {
          const active = i === highlightIndex;
          return (
            <li key={w.member.sessionId}>
              <button
                type="button"
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(w)}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                  active
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
                }`}
              >
                <span className="font-mono text-[var(--color-accent)] shrink-0">
                  @{w.member.alias}
                </span>
                {w.session && <AgentBadge agent={w.session.agent} size="xs" />}
                <span className="truncate">
                  {w.session?.title ??
                    `Chat ${w.member.sessionId.slice(0, 6)}`}
                </span>
                <span className="text-[10px] text-[var(--color-ink-muted)] shrink-0 ml-auto">
                  {w.projectName ?? ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
