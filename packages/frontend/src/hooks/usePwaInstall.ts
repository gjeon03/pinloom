import { useSyncExternalStore } from 'react';
import {
  detectIos,
  getPwaState,
  promptPwaInstall,
  subscribePwa,
} from '../stores/pwaInstall.js';

export interface PwaInstall {
  /** A deferred install prompt is available (Chromium, not yet installed). */
  canInstall: boolean;
  /** Already running as an installed app (standalone display). */
  isInstalled: boolean;
  /** iOS Safari — no programmatic prompt; show manual "Add to Home Screen". */
  isIos: boolean;
  /** Trigger the native prompt. Resolves to the user's choice (or null). */
  promptInstall: () => Promise<'accepted' | 'dismissed' | null>;
}

// The `beforeinstallprompt` event is captured at app startup (stores/pwaInstall
// listens at module-eval time), so this hook reads already-captured state even
// when the Settings modal mounts long after the event fired.
export function usePwaInstall(): PwaInstall {
  const state = useSyncExternalStore(subscribePwa, getPwaState, getPwaState);
  return {
    canInstall: state.canInstall,
    isInstalled: state.isInstalled,
    isIos: detectIos(),
    promptInstall: promptPwaInstall,
  };
}
