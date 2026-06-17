// Module-level capture of the PWA install prompt.
//
// Chromium fires `beforeinstallprompt` ONCE, shortly after page load — long
// before the user opens Settings. If we only attached the listener when the
// Settings modal (and its hook) mounted, the event would already be gone and
// the install button would never appear (even though Chrome still shows the
// address-bar install icon). So we listen at module-eval time — imported from
// main.tsx — and stash the deferred event globally; the hook then reads this
// captured state whenever it mounts.

// `beforeinstallprompt` isn't in the standard DOM lib types — it's the
// Chromium-only event that lets us defer the native prompt and fire it on a
// user gesture instead of whenever the browser decides.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIosDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as desktop Safari (Macintosh) but exposes touch.
  const isIpadOs =
    /macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return isIosDevice || isIpadOs;
}

export interface PwaState {
  canInstall: boolean;
  isInstalled: boolean;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = detectStandalone();
const listeners = new Set<() => void>();

// Cached so useSyncExternalStore's getSnapshot returns a stable reference
// between changes (a fresh object each call would loop). Recomputed only when
// the underlying state actually changes.
let snapshot: PwaState = computeSnapshot();

function computeSnapshot(): PwaState {
  return {
    canInstall: deferredPrompt !== null && !installed,
    isInstalled: installed,
  };
}

function emit() {
  snapshot = computeSnapshot();
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stop Chrome's mini-infobar; we drive the prompt from Settings.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });
  // The display mode can flip while the tab is open (install from the omnibox).
  window
    .matchMedia?.('(display-mode: standalone)')
    .addEventListener?.('change', () => {
      installed = detectStandalone();
      emit();
    });
}

export function getPwaState(): PwaState {
  return snapshot;
}

export function subscribePwa(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function promptPwaInstall(): Promise<
  'accepted' | 'dismissed' | null
> {
  if (!deferredPrompt) return null;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  // A deferred prompt is single-use — drop it so the button reflects state.
  deferredPrompt = null;
  emit();
  return outcome;
}
