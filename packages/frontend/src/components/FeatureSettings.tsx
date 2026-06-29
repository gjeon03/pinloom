import type { FeatureKey, ReasoningEffort } from '@pinloom/shared';
import {
  useUiConfig,
  setUiPreset,
  setFeature,
  setPicker,
  setUiLocale,
} from '../stores/uiConfig.js';
import { CLAUDE_MODELS } from './ModelPicker.js';

// Feature toggles grouped for the settings UI. Names stay English (proper
// nouns); descriptions/tooltips are translated in the i18n phase.
const FEATURE_GROUPS: { group: string; items: { key: FeatureKey; label: string }[] }[] = [
  {
    group: 'Workspace',
    items: [
      { key: 'teams', label: 'Teams' },
      { key: 'wiki', label: 'Wiki' },
      { key: 'timeline', label: 'Timeline' },
      { key: 'recap', label: 'Recap' },
    ],
  },
  {
    group: 'Session side rail',
    items: [
      { key: 'history', label: 'History' },
      { key: 'pins', label: 'Pins' },
      { key: 'sessionWikiTab', label: 'Session Wiki tab' },
    ],
  },
  {
    group: 'Tools',
    items: [
      { key: 'globalSearch', label: 'Global search (⌘K)' },
      { key: 'templates', label: 'Prompt templates' },
      { key: 'notepad', label: 'Notepad' },
    ],
  },
  {
    group: 'Bots',
    items: [
      { key: 'scheduleBot', label: 'Schedule bot' },
      { key: 'skillBot', label: 'Skill bot' },
    ],
  },
];

const EFFORT_VALUES: (ReasoningEffort | 'default')[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 cursor-pointer text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-3)]'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

const selectClass =
  'rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs';

export function FeatureSettings() {
  const config = useUiConfig();
  const { features, pickers, preset } = config;

  return (
    <div className="space-y-6">
      {/* Preset */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Preset
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          Start point for which features are visible. Toggling anything below switches to Custom.
        </p>
        <div className="flex gap-2">
          {(['simple', 'full', 'custom'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void setUiPreset(p)}
              disabled={p === 'custom' && preset !== 'custom'}
              className={`rounded px-3 py-1.5 text-xs border ${
                preset === p
                  ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-3)]'
                  : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              } ${p === 'custom' && preset !== 'custom' ? 'opacity-50 cursor-default' : ''}`}
            >
              {p === 'simple' ? 'Simple' : p === 'full' ? 'Full' : 'Custom'}
            </button>
          ))}
        </div>
      </section>

      {/* Features */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Features
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">
          Turning a feature off hides it everywhere. Your data is kept — turning it back on restores access.
        </p>
        <div className="space-y-4">
          {FEATURE_GROUPS.map(({ group, items }) => (
            <div key={group}>
              <div className="text-[11px] text-[var(--color-ink-muted)] mb-1">{group}</div>
              <div className="divide-y divide-[var(--color-border)]">
                {items.map(({ key, label }) => (
                  <Toggle
                    key={key}
                    label={label}
                    checked={features[key]}
                    onChange={(v) => void setFeature(key, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Defaults (pickers) */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Defaults
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">
          Show the per-session picker, or fix a value and hide the picker.
        </p>
        <div className="space-y-3 text-sm">
          {/* Model */}
          <div className="flex items-center justify-between gap-3">
            <span>Model</span>
            <select
              className={selectClass}
              value={pickers.model.mode === 'shown' ? '__shown__' : pickers.model.fixed}
              onChange={(e) => {
                const v = e.target.value;
                void setPicker('model', {
                  mode: v === '__shown__' ? 'shown' : 'fixed',
                  fixed: v === '__shown__' ? pickers.model.fixed : v,
                });
              }}
            >
              <option value="__shown__">Show picker</option>
              {CLAUDE_MODELS.filter((m) => m.id).map((m) => (
                <option key={m.id} value={m.id as string}>
                  Fixed: {m.label}
                </option>
              ))}
            </select>
          </div>
          {/* Effort */}
          <div className="flex items-center justify-between gap-3">
            <span>Effort</span>
            <select
              className={selectClass}
              value={pickers.effort.mode === 'shown' ? '__shown__' : pickers.effort.fixed}
              onChange={(e) => {
                const v = e.target.value;
                void setPicker('effort', {
                  mode: v === '__shown__' ? 'shown' : 'fixed',
                  fixed: v === '__shown__'
                    ? pickers.effort.fixed
                    : (v as ReasoningEffort | 'default'),
                });
              }}
            >
              <option value="__shown__">Show picker</option>
              {EFFORT_VALUES.map((e) => (
                <option key={e} value={e}>
                  Fixed: {e}
                </option>
              ))}
            </select>
          </div>
          {/* Transport */}
          <div className="flex items-center justify-between gap-3">
            <span>New-session mode</span>
            <select
              className={selectClass}
              value={pickers.transport.mode === 'shown' ? '__shown__' : pickers.transport.fixed}
              onChange={(e) => {
                const v = e.target.value;
                void setPicker('transport', {
                  mode: v === '__shown__' ? 'shown' : 'fixed',
                  fixed: v === '__shown__' ? pickers.transport.fixed : (v as 'sdk' | 'terminal'),
                });
              }}
            >
              <option value="__shown__">Show picker</option>
              <option value="terminal">Fixed: Terminal</option>
              <option value="sdk">Fixed: SDK (chat)</option>
            </select>
          </div>
        </div>
      </section>

      {/* Language */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Language
        </h3>
        <div className="flex gap-2">
          {(['en', 'ko'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => void setUiLocale(l)}
              className={`rounded px-3 py-1.5 text-xs border ${
                config.locale === l
                  ? 'border-[var(--color-accent)] text-[var(--color-ink)] bg-[var(--color-surface-3)]'
                  : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {l === 'en' ? 'English' : '한국어'}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
