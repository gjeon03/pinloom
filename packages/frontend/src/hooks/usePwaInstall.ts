import { useCallback, useEffect, useState } from 'react';

// `beforeinstallprompt` isn't in the standard DOM lib types — it's a
// Chromium-only event that lets us defer the native install prompt and fire
// it on a user gesture (a Settings button) instead of whenever the browser
// feels like it.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function detectStandalone(): boolean {
  // `display-mode: standalone` is the cross-browser signal; iOS Safari uses
  // the legacy `navigator.standalone` instead.
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function detectIos(): boolean {
  const ua = navigator.userAgent;
  const isIosDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as desktop Safari (Macintosh) but exposes touch.
  const isIpadOs =
    /macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return isIosDevice || isIpadOs;
}

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

export function usePwaInstall(): PwaInstall {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [isInstalled, setIsInstalled] = useState(detectStandalone);

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      // Stop Chrome's mini-infobar; we drive the prompt from Settings.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferred(null);
      setIsInstalled(true);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // The display mode can flip while the tab is open (the user installs from
    // the omnibox); keep `isInstalled` in sync.
    const mql = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayChange = () => setIsInstalled(detectStandalone());
    mql?.addEventListener?.('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      mql?.removeEventListener?.('change', onDisplayChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return null;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // A deferred prompt is single-use — drop it so the button reflects state.
    setDeferred(null);
    return outcome;
  }, [deferred]);

  return {
    canInstall: deferred !== null && !isInstalled,
    isInstalled,
    isIos: detectIos(),
    promptInstall,
  };
}
