import type { ReasoningEffort } from './types.js';
import { DEFAULT_CLAUDE_MODEL } from './constants.js';

// Per-install UI configuration: which features are visible, how the model/
// effort/transport pickers behave, and the UI language. Stored as a single
// JSON blob in app_settings under `ui_config` (DB = source of truth, shared by
// web + desktop on the unified DB). Disabling a feature only HIDES it — the
// underlying data (teams, wiki pages, notepads, …) is never deleted, so
// re-enabling restores access.

/** Toggleable features. A disabled feature is hidden everywhere in the UI; its
 *  data is kept (re-enabling restores it). NOTE: backend background jobs (wiki
 *  gardener/auto-analyze, timeline capture, recap) and wiki prompt-injection are
 *  NOT yet gated on these flags — that lives in a separate follow-up. Core
 *  chat/sessions are always on. */
export interface FeatureFlags {
  teams: boolean;
  wiki: boolean;
  timeline: boolean;
  recap: boolean;
  notepad: boolean;
  templates: boolean;
  scheduleBot: boolean;
  skillBot: boolean;
  globalSearch: boolean;
  pins: boolean;
  /** Per-session Wiki tab in the side rail (distinct from the Wiki section). */
  sessionWikiTab: boolean;
  /** Captured-turn history tab in the side rail (terminal sessions). */
  history: boolean;
}

export type FeatureKey = keyof FeatureFlags;

/** A picker is either shown to the user or fixed to a single value + hidden. */
export interface PickerSetting<T> {
  mode: 'shown' | 'fixed';
  fixed: T;
}

export interface PickerSettings {
  model: PickerSetting<string>;
  effort: PickerSetting<ReasoningEffort | 'default'>;
  transport: PickerSetting<'sdk' | 'terminal'>;
}

export type UiLocale = 'en' | 'ko';
export type UiPreset = 'simple' | 'full' | 'custom';

export interface UiConfig {
  version: 1;
  preset: UiPreset;
  features: FeatureFlags;
  pickers: PickerSettings;
  locale: UiLocale;
}

const ALL_FEATURES_ON: FeatureFlags = {
  teams: true,
  wiki: true,
  timeline: true,
  recap: true,
  notepad: true,
  templates: true,
  scheduleBot: true,
  skillBot: true,
  globalSearch: true,
  pins: true,
  sessionWikiTab: true,
  history: true,
};

// A fresh install defaults to FULL so existing single-user setups see no
// behavior change. A colleague who wants the minimal surface switches to the
// `simple` preset (or the settings UI offers it on first run).
export const DEFAULT_UI_CONFIG: UiConfig = {
  version: 1,
  preset: 'full',
  features: { ...ALL_FEATURES_ON },
  pickers: {
    model: { mode: 'shown', fixed: DEFAULT_CLAUDE_MODEL },
    effort: { mode: 'shown', fixed: 'default' },
    transport: { mode: 'shown', fixed: 'terminal' },
  },
  locale: 'en',
};

/** Feature sets per preset. `custom` keeps whatever the user has toggled. */
export const PRESET_FEATURES: Record<'simple' | 'full', FeatureFlags> = {
  full: { ...ALL_FEATURES_ON },
  // Minimal "just chat" surface for newcomers: keep sessions + history + pins +
  // search; hide the power-user systems (teams, wiki, timeline, recap, bots,
  // notepad, templates).
  simple: {
    teams: false,
    wiki: false,
    timeline: false,
    recap: false,
    notepad: false,
    templates: false,
    scheduleBot: false,
    skillBot: false,
    globalSearch: true,
    pins: true,
    sessionWikiTab: false,
    history: true,
  },
};

/** Pickers fixed to a single value under the `simple` preset (one less choice). */
const SIMPLE_PICKERS: PickerSettings = {
  model: { mode: 'fixed', fixed: DEFAULT_CLAUDE_MODEL },
  effort: { mode: 'fixed', fixed: 'default' },
  transport: { mode: 'fixed', fixed: 'terminal' },
};

/** Apply a named preset, returning a new config. `custom` is a no-op marker. */
export function applyPreset(config: UiConfig, preset: UiPreset): UiConfig {
  if (preset === 'custom') return { ...config, preset: 'custom' };
  return {
    ...config,
    preset,
    features: { ...PRESET_FEATURES[preset] },
    pickers: preset === 'simple' ? SIMPLE_PICKERS : { ...DEFAULT_UI_CONFIG.pickers },
  };
}

/** Deep-merge a (possibly partial / older-version) stored config over the
 *  defaults, so new features added later default sensibly. Unknown keys are
 *  dropped; missing keys fall back to DEFAULT_UI_CONFIG. */
export function mergeUiConfig(stored: unknown): UiConfig {
  const s = (stored ?? {}) as Partial<UiConfig>;
  const features = { ...DEFAULT_UI_CONFIG.features };
  for (const k of Object.keys(features) as FeatureKey[]) {
    const v = s.features?.[k];
    if (typeof v === 'boolean') features[k] = v;
  }
  const base = DEFAULT_UI_CONFIG.pickers;
  const pickers: PickerSettings = {
    model: mergePicker(base.model, s.pickers?.model),
    effort: mergePicker(base.effort, s.pickers?.effort),
    transport: mergePicker(base.transport, s.pickers?.transport),
  };
  return {
    version: 1,
    preset: s.preset === 'simple' || s.preset === 'full' || s.preset === 'custom' ? s.preset : 'full',
    features,
    pickers,
    locale: s.locale === 'ko' || s.locale === 'en' ? s.locale : 'en',
  };
}

function mergePicker<T>(base: PickerSetting<T>, stored: unknown): PickerSetting<T> {
  const s = (stored ?? {}) as Partial<PickerSetting<T>>;
  return {
    mode: s.mode === 'fixed' || s.mode === 'shown' ? s.mode : base.mode,
    fixed: s.fixed !== undefined ? (s.fixed as T) : base.fixed,
  };
}
