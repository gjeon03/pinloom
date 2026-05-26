import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentKind, ReasoningEffort } from '@pinloom/shared';

// Cross-agent "Effort" knob. Internal values map to each adapter's
// native control (Claude SDK `thinking` config, Codex `-c
// model_reasoning_effort`). Claude exposes a 5th 'max' tier with a
// large thinking budget — the picker filters that out for Codex
// sessions since the CLI doesn't accept it.
interface EffortOption {
  /** null = adapter default (no override) */
  id: ReasoningEffort | null;
  label: string;
  description: string;
}

const COMMON: EffortOption[] = [
  {
    id: null,
    label: 'Default',
    description: "Use whatever the agent's default reasoning level is",
  },
  {
    id: 'low',
    label: 'Low',
    description: 'Fastest, cheapest — for simple questions',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced (typical default)',
  },
  {
    id: 'high',
    label: 'High',
    description: 'More thinking time — better for complex work',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description: 'Even more thinking — for tough problems',
  },
];

const CLAUDE_MAX: EffortOption = {
  id: 'max',
  label: 'Max',
  description: 'Claude only — largest thinking budget',
};

function optionsFor(agent: AgentKind): EffortOption[] {
  return agent === 'claude' ? [...COMMON, CLAUDE_MAX] : COMMON;
}

export function findEffortLabel(
  id: ReasoningEffort | null | undefined,
): string {
  if (!id) return 'Default';
  const opt = [...COMMON, CLAUDE_MAX].find((o) => o.id === id);
  return opt?.label ?? id;
}

interface Props {
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  agent: AgentKind;
  side?: 'top' | 'bottom';
  disabled?: boolean;
}

interface FixedCoords {
  right: number;
  bottom?: number;
  top?: number;
}

const GAP = 6;

export function EffortPicker({
  value,
  onChange,
  agent,
  side = 'top',
  disabled = false,
}: Props) {
  const options = optionsFor(agent);
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

  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    function onScrollOrResize() {
      recompute();
    }
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-effort-picker-dropdown]')) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const currentLabel = findEffortLabel(value);
  const currentDescription = options.find((o) => o.id === value)?.description;

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={currentDescription}
        className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="font-medium">{currentLabel}</span>
        <ChevronDown size={10} />
      </button>
      {open && coords && (
        <div
          data-effort-picker-dropdown
          style={{
            position: 'fixed',
            right: coords.right,
            top: coords.top,
            bottom: coords.bottom,
          }}
          className="z-50 w-64 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        >
          <ul className="divide-y divide-[var(--color-border)]/40">
            {options.map((opt) => {
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
                      {selected && (
                        <Check size={12} className="text-[var(--color-accent)]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-[var(--color-ink)]">
                        {opt.label}
                      </div>
                      <div className="text-[var(--color-ink-muted)] text-[10px] mt-0.5">
                        {opt.description}
                      </div>
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
