// Right-side header actions for every dockview group: the '+' new-tab picker
// (Claude / Codex / Notepad), ported from the legacy strip. Rendering per
// group means a split pane gets its own '+', and the new tab lands in the
// group whose button was clicked — same mental model as VSCode.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, NotepadText, Plus } from 'lucide-react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { AgentBadge } from '../AgentBadge.js';
import { useDock } from './DockContext.js';

export function GroupActions(props: IDockviewHeaderActionsProps) {
  const ctx = useDock();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Click-outside dismiss — the panel is portaled into document.body, so
  // check both the anchor button and the floating panel.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (buttonRef.current && buttonRef.current.contains(t)) return;
      if (panelRef.current && panelRef.current.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="flex items-stretch self-stretch">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const r = buttonRef.current?.getBoundingClientRect();
          if (r) {
            setCoords({
              top: r.bottom + 4,
              right: Math.max(0, window.innerWidth - r.right),
            });
          }
          setOpen((v) => !v);
        }}
        className="flex items-center gap-0.5 px-2.5 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
        title="New tab — pick agent"
      >
        <Plus size={14} />
        <ChevronDown size={10} />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: coords.top,
              right: coords.right,
              zIndex: 50,
            }}
            className="min-w-[140px] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg py-1 text-xs"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                ctx.createSessionTab('claude', props.group.id);
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-3)] text-left"
            >
              <AgentBadge agent="claude" />
              <span className="flex-1">Claude</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                ctx.createSessionTab('codex', props.group.id);
              }}
              disabled={ctx.codexAvailable === false}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-3)] text-left disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                ctx.codexAvailable === false
                  ? 'Codex CLI not detected on PATH — install or run `codex login`'
                  : 'New Codex session'
              }
            >
              <AgentBadge agent="codex" />
              <span className="flex-1">Codex</span>
              {ctx.codexAvailable === false && (
                <span className="text-[9px] text-[var(--color-ink-muted)]">
                  N/A
                </span>
              )}
            </button>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                ctx.createNotepadTab(props.group.id);
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-3)] text-left"
            >
              <NotepadText size={14} className="text-[var(--color-accent)]" />
              <span className="flex-1">Notepad</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
