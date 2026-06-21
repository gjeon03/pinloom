// Prompt-template picker for the chat composer. Opened by a "/" slash trigger
// (filtered) or the toolbar button (full list). Mirrors MentionPopup's
// anchored, keyboard-navigable shape; purely presentational — ChatView owns
// the state and insertion. Distinct from the wiki: these are user-side
// reusable composer seeds, not agent memory.

import { useEffect, useRef } from 'react';
import { FilePlus, Settings } from 'lucide-react';
import type { PromptTemplate } from '@pinloom/shared';

interface Props {
  templates: PromptTemplate[];
  highlightIndex: number;
  onPick: (t: PromptTemplate) => void;
  onHover: (index: number) => void;
  onManage: () => void;
  /** Offer "save current draft" only when the composer has text. */
  canSaveDraft: boolean;
  onSaveDraft: () => void;
}

export function TemplatePopup({
  templates,
  highlightIndex,
  onPick,
  onHover,
  onManage,
  canSaveDraft,
  onSaveDraft,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const ul = listRef.current;
    const item = ul?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  return (
    <div
      className="absolute bottom-full mb-1 left-0 z-40 w-80 max-w-[90vw] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
      data-template-popup
      onMouseDown={(e) => {
        // Keep the textarea focused so a row click doesn't close the popup first.
        e.preventDefault();
      }}
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] border-b border-[var(--color-border)]/40">
        Prompt templates
      </div>

      {templates.length === 0 ? (
        <div className="px-3 py-3 text-xs text-[var(--color-ink-muted)]">
          No templates yet — register your reusable prompts.
        </div>
      ) : (
        <ul ref={listRef} className="max-h-60 overflow-y-auto py-1">
          {templates.map((t, i) => {
            const active = i === highlightIndex;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(t)}
                  className={`w-full text-left px-3 py-1.5 ${
                    active
                      ? 'bg-[var(--color-surface-3)]'
                      : 'hover:bg-[var(--color-surface-3)]'
                  }`}
                >
                  <div className="text-xs font-medium text-[var(--color-ink)] truncate">
                    {t.title}
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-muted)] truncate">
                    {t.body.replace(/\s+/g, ' ').trim()}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)]/40 px-2 py-1">
        <button
          type="button"
          onClick={onManage}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
        >
          <Settings size={12} /> Manage templates…
        </button>
        {canSaveDraft && (
          <button
            type="button"
            onClick={onSaveDraft}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
          >
            <FilePlus size={12} /> Save draft
          </button>
        )}
      </div>
    </div>
  );
}
