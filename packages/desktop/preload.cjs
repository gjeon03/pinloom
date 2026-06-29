// Minimal, tightly-scoped bridge between the renderer (the pinloom web app) and
// the Electron main process. contextIsolation is ON and nodeIntegration is OFF
// (see main.cjs) — this is the ONLY surface the renderer can use to reach
// native APIs, so it stays a small allowlist of named, parameter-validated
// channels. No generic ipcRenderer passthrough.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pinloomDesktop', {
  // Marker so the renderer can detect it's running inside the desktop app.
  isDesktop: true,
  // Bring the (possibly hidden) window to the front — used when the user clicks
  // a native "agent finished" notification.
  requestFocus: () => ipcRenderer.invoke('pinloom:focus'),
  // Set the dock badge to the running-session count (coerced + clamped in main).
  setBadge: (count) => ipcRenderer.invoke('pinloom:set-badge', count),
});
