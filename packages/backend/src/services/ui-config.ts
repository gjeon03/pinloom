import { getSetting, setSetting } from './app-settings.js';
import { mergeUiConfig, type UiConfig } from '@pinloom/shared';

// The per-install UI config lives in app_settings under this key as a JSON
// blob. Always read/written through mergeUiConfig so a partial or older-version
// stored value is normalized against the current defaults.
const UI_CONFIG_KEY = 'ui_config';

export function getUiConfig(): UiConfig {
  const raw = getSetting(UI_CONFIG_KEY);
  if (!raw) return mergeUiConfig(undefined);
  try {
    return mergeUiConfig(JSON.parse(raw));
  } catch {
    return mergeUiConfig(undefined);
  }
}

export function setUiConfig(next: unknown): UiConfig {
  const merged = mergeUiConfig(next);
  setSetting(UI_CONFIG_KEY, JSON.stringify(merged));
  return merged;
}
