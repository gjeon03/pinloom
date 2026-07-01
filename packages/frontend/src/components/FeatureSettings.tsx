import type { FeatureKey, ReasoningEffort } from '@pinloom/shared';
import {
  useUiConfig,
  setUiPreset,
  setFeature,
  setPicker,
  setUiLocale,
} from '../stores/uiConfig.js';
import { useT } from '../i18n/t.js';
import { CLAUDE_MODELS } from './ModelPicker.js';

// Feature toggles grouped for the settings UI. Labels resolve via t('feature.*')
// — names stay English (proper nouns); group headers + descriptions translate.
const FEATURE_GROUPS: { group: string; items: FeatureKey[] }[] = [
  { group: 'workspace', items: ['teams', 'wiki', 'timeline', 'recap'] },
  { group: 'sideRail', items: ['history', 'pins', 'sessionWikiTab'] },
  { group: 'tools', items: ['globalSearch', 'templates', 'notepad'] },
  { group: 'bots', items: ['scheduleBot', 'skillBot'] },
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
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}

const selectClass =
  'rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs';

export function FeatureSettings() {
  const t = useT();
  const config = useUiConfig();
  const { features, pickers, preset } = config;

  return (
    <div className="space-y-6">
      {/* Preset */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          {t('settings.preset')}
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          {t('settings.preset.desc')}
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
              {t(`settings.preset.${p}`)}
            </button>
          ))}
        </div>
      </section>

      {/* Features */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          {t('settings.features')}
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">
          {t('settings.features.desc')}
        </p>
        <div className="space-y-4">
          {FEATURE_GROUPS.map(({ group, items }) => (
            <div key={group}>
              <div className="text-[11px] text-[var(--color-ink-muted)] mb-1">
                {t(`settings.group.${group}`)}
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {items.map((key) => (
                  <Toggle
                    key={key}
                    label={t(`feature.${key}`)}
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
          {t('settings.defaults')}
        </h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">
          {t('settings.defaults.desc')}
        </p>
        <div className="space-y-3 text-sm">
          {/* Model */}
          <div className="flex items-center justify-between gap-3">
            <span>{t('settings.model')}</span>
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
              <option value="__shown__">{t('settings.showPicker')}</option>
              {CLAUDE_MODELS.filter((m) => m.id).map((m) => (
                <option key={m.id} value={m.id as string}>
                  {t('settings.fixed', { value: m.label })}
                </option>
              ))}
            </select>
          </div>
          {/* Effort */}
          <div className="flex items-center justify-between gap-3">
            <span>{t('settings.effort')}</span>
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
              <option value="__shown__">{t('settings.showPicker')}</option>
              {EFFORT_VALUES.map((e) => (
                <option key={e} value={e}>
                  {t('settings.fixed', { value: e })}
                </option>
              ))}
            </select>
          </div>
          {/* Transport */}
          <div className="flex items-center justify-between gap-3">
            <span>{t('settings.transport')}</span>
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
              <option value="__shown__">{t('settings.showPicker')}</option>
              <option value="terminal">
                {t('settings.fixed', { value: t('settings.transport.terminal') })}
              </option>
              <option value="sdk">
                {t('settings.fixed', { value: t('settings.transport.sdk') })}
              </option>
            </select>
          </div>
        </div>
      </section>

      {/* Language */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          {t('settings.language')}
        </h3>
        <div className="flex gap-2">
          {(['en', 'ko', 'zh'] as const).map((l) => (
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
              {{ en: 'English', ko: '한국어', zh: '中文' }[l]}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
