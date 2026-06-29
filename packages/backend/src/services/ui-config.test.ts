import { describe, it, expect } from 'vitest';
import {
  applyPreset,
  mergeUiConfig,
  DEFAULT_UI_CONFIG,
  PRESET_FEATURES,
} from '@pinloom/shared';
import { getUiConfig, setUiConfig } from './ui-config.js';

describe('ui-config', () => {
  it('mergeUiConfig fills defaults for a partial / older stored value', () => {
    const m = mergeUiConfig({ features: { teams: false } });
    expect(m.features.teams).toBe(false); // honored
    expect(m.features.wiki).toBe(true); // filled from default
    expect(m.locale).toBe('en');
    expect(m.preset).toBe('full');
    expect(m.pickers.model.mode).toBe('shown');
  });

  it('mergeUiConfig(undefined) === full defaults', () => {
    expect(mergeUiConfig(undefined)).toEqual(DEFAULT_UI_CONFIG);
  });

  it('applyPreset(simple) hides power features + fixes pickers, keeps chat core', () => {
    const c = applyPreset(DEFAULT_UI_CONFIG, 'simple');
    expect(c.preset).toBe('simple');
    expect(c.features).toEqual(PRESET_FEATURES.simple);
    expect(c.features.teams).toBe(false);
    expect(c.features.wiki).toBe(false);
    expect(c.features.history).toBe(true); // chat core stays
    expect(c.features.pins).toBe(true);
    expect(c.pickers.model.mode).toBe('fixed');
    expect(c.pickers.transport.mode).toBe('fixed');
  });

  it('applyPreset(full) restores everything', () => {
    const simple = applyPreset(DEFAULT_UI_CONFIG, 'simple');
    const full = applyPreset(simple, 'full');
    expect(full.features).toEqual(PRESET_FEATURES.full);
    expect(full.pickers.model.mode).toBe('shown');
  });

  it('setUiConfig persists and getUiConfig reads it back (normalized)', () => {
    setUiConfig(applyPreset(DEFAULT_UI_CONFIG, 'simple'));
    const got = getUiConfig();
    expect(got.preset).toBe('simple');
    expect(got.features.teams).toBe(false);
    expect(got.pickers.transport.mode).toBe('fixed');
    // restore so other suites that read ui_config see defaults again
    setUiConfig(DEFAULT_UI_CONFIG);
    expect(getUiConfig().preset).toBe('full');
  });
});
