import type { UiLocale } from '@pinloom/shared';
import { useUiLocale } from '../stores/uiConfig.js';
import { STRINGS } from './strings.js';

// Lightweight i18n. STRINGS (strings.ts) is the single source: key → {en, ko}.
// English is the fallback for a locale missing a value, and the key itself is
// the last-resort fallback so a missing string is visible, never blank. Proper
// nouns (Wiki, Teams, Recap…) read the same in every locale by design.

export function translate(
  locale: UiLocale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const entry = STRINGS[key];
  const s = entry ? (entry[locale] ?? entry.en) : key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
  );
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Hook: returns a `t` bound to the current UI locale (re-renders on change). */
export function useT(): TFn {
  const locale = useUiLocale();
  return (key, vars) => translate(locale, key, vars);
}
