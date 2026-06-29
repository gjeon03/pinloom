// Desktop (Electron) integration helpers. The desktop app injects a tiny
// `window.pinloomDesktop` bridge via preload (see packages/desktop/preload.cjs);
// in a normal browser it's absent and these all no-op gracefully.

interface PinloomDesktopBridge {
  isDesktop: boolean;
  requestFocus(): Promise<void>;
  setBadge(count: number): Promise<void>;
}

declare global {
  interface Window {
    pinloomDesktop?: PinloomDesktopBridge;
  }
}

function bridge(): PinloomDesktopBridge | null {
  return typeof window !== 'undefined' ? (window.pinloomDesktop ?? null) : null;
}

// Whether the frontend is running inside the pinloom Electron desktop app
// (vs a normal web browser / installed PWA). Prefers the injected bridge; falls
// back to the User-Agent (Electron sets "Electron/<version>"). Used to hide
// browser-only UI (PWA install, launchd autostart) and enable native features.
export function isDesktopApp(): boolean {
  if (bridge()) return true;
  if (typeof navigator === 'undefined') return false;
  return /\bElectron\//.test(navigator.userAgent);
}

// Bring the (possibly hidden/menu-bar) desktop window to the front.
export function focusDesktopWindow(): void {
  void bridge()?.requestFocus();
}

// Set the dock badge to a count (0 clears it). No-op in a browser.
export function setDockBadge(count: number): void {
  void bridge()?.setBadge(count);
}

// Fire a native OS notification (desktop app only). The Web Notification API in
// Electron maps to a real macOS banner. `onClick` runs when the user clicks it.
export function notifyNative(opts: {
  title: string;
  body?: string;
  onClick?: () => void;
}): void {
  if (!bridge() || typeof Notification === 'undefined') return;
  const fire = () => {
    try {
      const n = new Notification(opts.title, { body: opts.body });
      if (opts.onClick) {
        n.onclick = () => {
          focusDesktopWindow();
          opts.onClick?.();
        };
      }
    } catch {
      // notification construction can throw if permission was revoked — ignore
    }
  };
  if (Notification.permission === 'granted') {
    fire();
  } else if (Notification.permission !== 'denied') {
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') fire();
    });
  }
}
