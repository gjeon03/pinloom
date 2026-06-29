import { useSyncExternalStore } from 'react';
import {
  mergeUiConfig,
  applyPreset,
  type UiConfig,
  type FeatureFlags,
  type FeatureKey,
  type PickerSettings,
  type UiLocale,
  type UiPreset,
} from '@pinloom/shared';

// UI config store. DB (`/api/settings/ui-config`) is the source of truth, but a
// localStorage cache lets the first paint gate features WITHOUT a flash — we
// hydrate synchronously from cache, then revalidate from the server. Mirrors
// the theme.ts / recapStore.ts useSyncExternalStore pattern.

const CACHE_KEY = 'pinloom:uiConfig';

function readCache(): UiConfig {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return mergeUiConfig(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return mergeUiConfig(undefined); // defaults (full preset)
}

function writeCache(c: UiConfig): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

let current: UiConfig = readCache();
const listeners = new Set<() => void>();

function set(next: UiConfig): void {
  current = next;
  writeCache(current);
  applySideEffects(current);
  listeners.forEach((l) => l());
}

// Locale → <html lang> so the document reflects the UI language (i18n reads the
// locale from this store; this just keeps the DOM attribute in sync).
function applySideEffects(c: UiConfig): void {
  if (typeof document !== 'undefined') document.documentElement.lang = c.locale;
}
applySideEffects(current);

let hydrated = false;
/** Revalidate from the server once at startup (fire-and-forget). */
export async function hydrateUiConfig(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const res = await fetch('/api/settings/ui-config');
    if (res.ok) set(mergeUiConfig(await res.json()));
  } catch {
    /* offline / not ready — keep cached */
  }
}

async function persist(next: UiConfig): Promise<void> {
  set(next);
  try {
    await fetch('/api/settings/ui-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
  } catch {
    /* keep optimistic local value; will re-sync next hydrate */
  }
}

/** Apply a named preset (simple/full/custom). */
export function setUiPreset(preset: UiPreset): Promise<void> {
  return persist(applyPreset(current, preset));
}

/** Toggle a single feature — flips the config to the `custom` preset. */
export function setFeature(key: FeatureKey, value: boolean): Promise<void> {
  return persist({
    ...current,
    preset: 'custom',
    features: { ...current.features, [key]: value },
  });
}

/** Update one picker setting — also marks the config `custom`. */
export function setPicker<K extends keyof PickerSettings>(
  key: K,
  value: PickerSettings[K],
): Promise<void> {
  return persist({
    ...current,
    preset: 'custom',
    pickers: { ...current.pickers, [key]: value },
  });
}

export function setUiLocale(locale: UiLocale): Promise<void> {
  return persist({ ...current, locale });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): UiConfig {
  return current;
}

export function useUiConfig(): UiConfig {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useFeatures(): FeatureFlags {
  return useUiConfig().features;
}

export function usePickers(): PickerSettings {
  return useUiConfig().pickers;
}

export function useUiLocale(): UiLocale {
  return useUiConfig().locale;
}
