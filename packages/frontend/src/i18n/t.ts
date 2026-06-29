import { useUiLocale } from '../stores/uiConfig.js';
import { en } from './en.js';
import { ko } from './ko.js';

// Lightweight i18n. Keys live in en.ts/ko.ts (flat, dotted namespaces). English
// is the fallback for any key missing in another locale, and the key itself is
// the last-resort fallback so a missing string is visible, never blank. Proper
// nouns (Wiki, Teams, Recap…) intentionally read the same in every locale.
export type Dict = Record<string, string>;

const DICTS: Record<string, Dict> = { en, ko };

export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const dict = DICTS[locale] ?? en;
  const s = dict[key] ?? en[key] ?? key;
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
