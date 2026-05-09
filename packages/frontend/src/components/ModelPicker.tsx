import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentKind } from '@pinloom/shared';

export interface ModelOption {
  /** SDK / CLI model id; null/undefined → CLI default */
  id: string | null;
  label: string;
  description?: string;
}

export const CLAUDE_MODELS: ModelOption[] = [
  {
    id: null,
    label: 'CLI default',
    description: 'Use whatever your local Claude Code CLI is configured for',
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

export const CODEX_MODELS: ModelOption[] = [
  {
    id: null,
    label: 'CLI default',
    description: "Use whatever your local Codex CLI is configured for (~/.codex/config.toml)",
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Frontier general-purpose model',
  },
  {
    id: 'o3',
    label: 'o3',
    description: 'Reasoning model — slower, better at hard logic',
  },
];

export function modelsFor(agent: AgentKind): ModelOption[] {
  return agent === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

// Resolve a model id to a human label by searching every agent's curated
// list. Falls back to the raw id (for custom-entered models) or "CLI default"
// when null/empty.
export function findModelLabel(id: string | null | undefined): string {
  if (id == null || id === '') return 'CLI default';
  const all = [...CLAUDE_MODELS, ...CODEX_MODELS];
  const opt = all.find((m) => m.id === id);
  return opt?.label ?? id;
}

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  agent: AgentKind;
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

export function ModelPicker({
  value,
  onChange,
  agent,
  side = 'top',
  disabled = false,
}: Props) {
  const options = modelsFor(agent);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<FixedCoords | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The currently-selected value may be a custom string that's not in this
  // agent's curated list (or even from a different agent's list — sessions
  // own their model independently). We surface it as "Custom: <id>" with a
  // check, and seed the custom-input box with it when the dropdown opens.
  const isCurated = value === null || options.some((m) => m.id === value);
  const customInitial = !isCurated && value ? value : '';
  const [customDraft, setCustomDraft] = useState(customInitial);

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

  // Reset the draft to the current custom value whenever the dropdown opens
  // so the input always reflects the live state.
  useLayoutEffect(() => {
    if (!open) return;
    setCustomDraft(customInitial);
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

  const currentLabel = isCurated
    ? (options.find((m) => m.id === (value ?? null))?.label ?? 'CLI default')
    : `Custom: ${value}`;
  const currentDescription = isCurated
    ? options.find((m) => m.id === (value ?? null))?.description
    : `Custom model id passed verbatim to ${agent}`;

  function commitCustom() {
    const trimmed = customDraft.trim();
    if (trimmed.length === 0) return;
    onChange(trimmed);
    setOpen(false);
  }

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
            {!isCurated && (
              <li>
                <div
                  className="w-full text-left px-3 py-2 text-xs flex items-start gap-2 bg-[var(--color-surface-3)]/50"
                >
                  <div className="shrink-0 w-3 mt-0.5">
                    <Check size={12} className="text-[var(--color-accent)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--color-ink)]">Custom: {value}</div>
                    <div className="text-[var(--color-ink-muted)] text-[10px] mt-0.5">
                      Custom model id passed verbatim to {agent}
                    </div>
                  </div>
                </div>
              </li>
            )}
          </ul>
          <div className="px-3 py-2 border-t border-[var(--color-border)]/40 space-y-1.5">
            <label className="block text-[10px] text-[var(--color-ink-muted)] uppercase tracking-wide">
              Custom model id
            </label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCustom();
                  } else if (e.key === 'Escape') {
                    setOpen(false);
                  }
                }}
                placeholder={agent === 'codex' ? 'e.g. gpt-5.4-codex' : 'e.g. claude-opus-5'}
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={commitCustom}
                disabled={customDraft.trim().length === 0}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Set
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
