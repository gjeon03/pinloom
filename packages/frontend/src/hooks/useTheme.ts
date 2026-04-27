import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  effectiveTheme,
  getStoredPreference,
  setStoredPreference,
  watchSystem,
  type EffectiveTheme,
  type ThemePreference,
} from '../theme.js';

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    getStoredPreference(),
  );
  const [effective, setEffective] = useState<EffectiveTheme>(() =>
    effectiveTheme(getStoredPreference()),
  );

  // If preference is 'system', stay in sync with OS theme changes.
  useEffect(() => {
    return watchSystem(() => {
      if (preference === 'system') {
        applyTheme('system');
        setEffective(effectiveTheme('system'));
      }
    });
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    applyTheme(next);
    setPreferenceState(next);
    setEffective(effectiveTheme(next));
  }, []);

  const toggle = useCallback(() => {
    setPreference(effective === 'light' ? 'dark' : 'light');
  }, [effective, setPreference]);

  return { preference, effective, setPreference, toggle };
}
