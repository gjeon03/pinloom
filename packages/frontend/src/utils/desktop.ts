// Whether the frontend is running inside the pinloom Electron desktop app
// (vs a normal web browser / installed PWA). Electron sets a User-Agent that
// includes "Electron/<version>". Used to hide UI that only makes sense in a
// browser — installing the PWA, and the launchd login-autostart toggle (the
// desktop app manages its own backend + has its own Tray "Open at Login").
export function isDesktopApp(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /\bElectron\//.test(navigator.userAgent);
}
