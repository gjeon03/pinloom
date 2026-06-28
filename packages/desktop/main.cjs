// pinloom desktop shell. A thin Electron wrapper: it does NOT run the backend
// (launchd already keeps backend:4748 + frontend:4747 alive) — it just opens a
// native window onto http://localhost:4747 so pinloom lives in its own app +
// dock icon instead of a browser tab. Backend lifecycle stays exactly as-is.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TARGET_URL = process.env.PINLOOM_DESKTOP_URL || 'http://localhost:4747';

// Single instance — focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
}
function saveState(win) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    // best-effort
  }
}

// Resolve only when the frontend answers (launchd may still be booting it).
function isUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createWindow() {
  const st = loadState();
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    title: 'pinloom',
    backgroundColor: '#1a1b26',
    autoHideMenuBar: true,
    webPreferences: {
      // Loading a remote (localhost) origin — keep node out of the renderer.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.on('close', () => saveState(win));

  // Links that open a new window (target=_blank) → system browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigations that leave localhost → system browser; keep the app on pinloom.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadFile(path.join(__dirname, 'loading.html'));
  // Poll up to ~60s for the frontend (handles a cold launchd boot).
  for (let i = 0; i < 60; i++) {
    if (win.isDestroyed()) return win;
    if (await isUp(TARGET_URL)) break;
    await sleep(1000);
  }
  if (!win.isDestroyed()) await win.loadURL(TARGET_URL);
  return win;
}

app.whenReady().then(createWindow);

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => app.quit());
