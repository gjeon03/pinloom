import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface ModelOption {
  /** SDK model id; null/undefined → CLI default */
  id: string | null;
  label: string;
  description?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: null,
    label: 'CLI default',
    description: "Use whatever your local Claude Code CLI is configured for",
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    description: 'Most capable, best for hard refactors / planning',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Balanced speed/quality, default for most edits',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description: 'Fastest + cheapest, good for quick lookups',
  },
];

export function findModelLabel(id: string | null | undefined): string {
  const opt = MODEL_OPTIONS.find((m) => m.id === (id ?? null));
  return opt?.label ?? id ?? 'CLI default';
}

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  side?: 'top' | 'bottom';
  disabled?: boolean;
}

interface FixedCoords {
  /** distance from viewport right edge to dropdown right edge */
  right: number;
  /** for side='top': distance from viewport bottom to dropdown bottom */
  bottom?: number;
  /** for side='bottom': distance from viewport top to dropdown top */
  top?: number;
}

const GAP = 6;

export function ModelPicker({ value, onChange, side = 'top', disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<FixedCoords | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  function recompute() {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - rect.right);
    if (side === 'top') {
      setCoords({ right, bottom: window.innerHeight - rect.top + GAP });
    } else {
      setCoords({ right, top: rect.bottom + GAP });
    }
  }

  // Recompute on open + on resize/scroll while open so the dropdown follows
  // any layout changes.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    function onChange() {
      recompute();
    }
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side]);

  // Outside click → close
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-model-picker-dropdown]')) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const current = MODEL_OPTIONS.find((m) => m.id === (value ?? null)) ?? MODEL_OPTIONS[0];

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={current.description}
        className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="font-medium">{current.label}</span>
        <ChevronDown size={10} />
      </button>
      {open && coords && (
        <div
          data-model-picker-dropdown
          style={{
            position: 'fixed',
            right: coords.right,
            top: coords.top,
            bottom: coords.bottom,
          }}
          className="z-50 w-64 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        >
          <ul className="divide-y divide-[var(--color-border)]/40">
            {MODEL_OPTIONS.map((opt) => {
              const selected = (opt.id ?? null) === (value ?? null);
              return (
                <li key={opt.id ?? 'default'}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(opt.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-start gap-2 hover:bg-[var(--color-surface-3)] ${
                      selected ? 'bg-[var(--color-surface-3)]/50' : ''
                    }`}
                  >
                    <div className="shrink-0 w-3 mt-0.5">
                      {selected && <Check size={12} className="text-[var(--color-accent)]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-[var(--color-ink)]">{opt.label}</div>
                      {opt.description && (
                        <div className="text-[var(--color-ink-muted)] text-[10px] mt-0.5">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
