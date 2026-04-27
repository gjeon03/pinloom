export type ThemePreference = 'dark' | 'light' | 'system';
export type EffectiveTheme = 'dark' | 'light';

const STORAGE_KEY = 'pinloom:theme';

export function getStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // localStorage unavailable; fall through
  }
  return 'system';
}

export function setStoredPreference(pref: ThemePreference) {
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore
  }
}

export function systemPreferred(): EffectiveTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function effectiveTheme(pref: ThemePreference): EffectiveTheme {
  return pref === 'system' ? systemPreferred() : pref;
}

export function applyTheme(pref: ThemePreference) {
  const eff = effectiveTheme(pref);
  document.documentElement.dataset.theme = eff;
}

export function watchSystem(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: light)');
  const listener = () => onChange();
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
