// pinloom desktop app — a resident, backend-owning macOS app.
//
// Lifecycle: the app lives in the menu bar (Tray) and stays running with its
// backend even when the window is closed, so background work (indexing,
// timeline, wiki gardener) keeps going. Closing the window HIDES it; the app
// only really quits from the Tray "Quit" or Cmd-Q.
//
// Backend: if a pinloom is already serving locally (a developer's launchd on
// :4747) the window just CONNECTS to it. Otherwise the app SPAWNS its own
// backend via Electron-as-node (serving API + the built frontend on one port),
// using a canonical on-disk database under ~/.pinloom/data. claude/codex CLIs
// can't be bundled — the user installs + logs into Claude Code themselves.
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  dialog,
  nativeImage,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

// A pinloom that's already serving (dev frontend / launchd prod). When this
// answers we connect instead of spawning our own backend.
const CONNECT_URL = process.env.PINLOOM_DESKTOP_CONNECT_URL || 'http://localhost:4747';
// Port our spawned sidecar backend listens on (API + static frontend, one
// origin). Deliberately NOT 4748 so a spawned instance never collides with a
// developer's launchd backend on the standard port.
const SIDECAR_PORT = Number(process.env.PINLOOM_DESKTOP_SIDECAR_PORT) || 4788;
// Test/dev hook: force the spawn path even when something answers CONNECT_URL.
const FORCE_SPAWN = process.env.PINLOOM_DESKTOP_FORCE_SPAWN === '1';
// Resident backend restarts: if the spawned backend dies unexpectedly we
// relaunch it rather than killing the whole app, up to this many times before
// surfacing a dialog (and still staying resident so the user can quit via Tray).
const MAX_BACKEND_RESTARTS = 5;

let mainWindow = null;
let tray = null;
let backendChild = null;
let backendRestarts = 0;
// True only once a real quit is requested (Tray Quit / Cmd-Q / before-quit), so
// window-close can distinguish "hide to tray" from "actually exiting".
app.isQuitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ── window state ──────────────────────────────────────────────────────────
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
    if (win && !win.isDestroyed()) fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    // best-effort
  }
}

// ── liveness probe ──────────────────────────────────────────────────────────
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

// ── sidecar backend (SPAWN path) ────────────────────────────────────────────
// Resolve the bundled backend entry + static dir. In the packaged app these sit
// under Resources/; in dev they're provided via env so `electron .` can spawn
// against a locally-built backend without packaging.
function backendEntry() {
  return (
    process.env.PINLOOM_BACKEND_ENTRY ||
    path.join(process.resourcesPath, 'app-backend', 'dist', 'server.js')
  );
}
function staticDir() {
  return (
    process.env.PINLOOM_STATIC_DIR || path.join(process.resourcesPath, 'app-frontend')
  );
}
// Canonical database location. Consolidated under ~/.pinloom (alongside the
// wiki at ~/.pinloom/wiki) so the app's data lives in one predictable,
// user-controlled place rather than buried in Electron's userData. Overridable
// via PINLOOM_DB_PATH (tests, or a custom data dir).
function canonicalDbPath() {
  return (
    process.env.PINLOOM_DB_PATH || path.join(os.homedir(), '.pinloom', 'data', 'pinloom.sqlite')
  );
}

// A GUI app launched from Finder inherits only a minimal PATH (/usr/bin:/bin:
// …), so a user-installed `claude`/`codex` (npm-global, Homebrew, asdf) is
// invisible to the spawned backend — it would report the CLIs as "not
// installed" and fail to launch agent terminals. Resolve the user's real
// login-shell PATH once and merge in the usual install locations.
function enrichedPath() {
  const fallback = [
    process.env.PATH || '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.asdf/shims'),
  ]
    .filter(Boolean)
    .join(':');
  try {
    // `-lc` (login, NOT interactive): sources the user's profile for PATH
    // without `-i`, which can source an rc that prints banners or blocks on a
    // prompt and hang us until the timeout on every launch. asdf/Homebrew paths
    // are also covered by the fallback below, so login-only is enough.
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return `${out}:${fallback}`;
  } catch {
    // login shell unavailable — fall back to the well-known locations
  }
  return fallback;
}

function spawnBackend() {
  const entry = backendEntry();
  if (!fs.existsSync(entry)) {
    dialog.showErrorBox(
      'pinloom',
      `Bundled backend not found at:\n${entry}\n\nThe app may be built incorrectly.`,
    );
    app.quit();
    return null;
  }
  // The sidecar's entire purpose is to serve the SPA — without the static dir
  // the window would load a bare JSON 404. Fail loudly instead.
  const staticRoot = staticDir();
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
    dialog.showErrorBox(
      'pinloom',
      `Bundled frontend not found at:\n${staticRoot}\n\nThe app may be built incorrectly.`,
    );
    app.quit();
    return null;
  }
  const dbPath = canonicalDbPath();
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {
    // backend will surface a clearer error if the dir is truly unwritable
  }

  // ELECTRON_RUN_AS_NODE: run our own Electron binary as plain Node (no system
  // Node needed). The backend's MCP child re-spawns process.execPath the same
  // way (runner.ts adds the flag), so the whole tree stays self-contained.
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PATH: enrichedPath(),
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(SIDECAR_PORT),
      PINLOOM_SERVE_STATIC: '1',
      PINLOOM_STATIC_DIR: staticRoot,
      PINLOOM_DB_PATH: dbPath,
      // The orchestrator/bot MCP children talk HTTP back to the backend; point
      // them at the sidecar port instead of the default 4748.
      PINLOOM_MCP_BACKEND_URL: `http://localhost:${SIDECAR_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.on('exit', (code, signal) => {
    backendChild = null;
    if (app.isQuitting) return; // expected teardown
    // A signalled exit we didn't request, or a non-zero code, means the backend
    // died on its own. Stay resident and try to bring it back rather than
    // killing the whole app; only give up (with a dialog) after several tries.
    if (signal == null && code === 0) return; // clean voluntary exit (shouldn't happen)
    if (backendRestarts < MAX_BACKEND_RESTARTS) {
      backendRestarts += 1;
      const delay = Math.min(1000 * backendRestarts, 5000);
      console.error(
        `[backend] exited (code ${code}, signal ${signal}) — restarting in ${delay}ms ` +
          `(${backendRestarts}/${MAX_BACKEND_RESTARTS})`,
      );
      setTimeout(() => {
        if (app.isQuitting) return;
        backendChild = spawnBackend();
        // Reload the window onto the fresh backend once it answers.
        void waitAndLoad(`http://localhost:${SIDECAR_PORT}`);
      }, delay);
    } else {
      dialog.showErrorBox(
        'pinloom',
        `The pinloom backend keeps exiting (last code ${code}). The app will stay ` +
          `in the menu bar; quit and relaunch, or check the logs.`,
      );
    }
  });
  // If a quit was requested while we were still deciding/probing, before-quit
  // already ran (with no child to kill); tear this just-spawned one down so it
  // can't be orphaned.
  if (app.isQuitting) child.kill('SIGTERM');
  return child;
}

// Decide CONNECT vs SPAWN and return the URL the window should load. Probe
// /api/ping (not /) so we only CONNECT to an actual pinloom backend, not any
// unrelated dev server that happens to answer on :4747.
async function resolveTarget() {
  if (!FORCE_SPAWN && (await isUp(`${CONNECT_URL}/api/ping`))) {
    return CONNECT_URL;
  }
  if (!backendChild) backendChild = spawnBackend();
  return `http://localhost:${SIDECAR_PORT}`;
}

// Poll a target until it answers, then load it into the window (if one exists).
async function waitAndLoad(target) {
  for (let i = 0; i < 60; i++) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (await isUp(`${target}/api/ping`)) break;
    await sleep(1000);
  }
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(target);
}

// ── window ───────────────────────────────────────────────────────────────────
async function createWindow({ show = true } = {}) {
  const st = loadState();
  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false, // shown explicitly once content is ready (avoids a white flash)
    title: 'pinloom',
    backgroundColor: '#1a1b26',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const win = mainWindow;
  win.on('close', (e) => {
    saveState(win);
    // Closing the window HIDES it (resident app); only a real quit destroys it.
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadFile(path.join(__dirname, 'loading.html'));
  if (show && !win.isDestroyed()) win.show();

  const target = await resolveTarget();
  await waitAndLoad(target);
  return win;
}

// Show the window, creating it if it was fully closed/destroyed.
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    void createWindow({ show: true });
  }
}

// ── tray (menu-bar resident) ─────────────────────────────────────────────────
function trayImage() {
  // A colored 22pt icon (with @2x sibling auto-picked up). Resolved relative to
  // main.cjs so it works both in dev and inside the packaged app.asar.
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (img.isEmpty()) return img; // Electron renders a default placeholder
  return img.resize({ width: 18, height: 18 });
}

function buildTrayMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Open pinloom', click: showWindow },
    { type: 'separator' },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
        // Rebuild so the checkmark reflects the OS state we just set.
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit pinloom',
      accelerator: 'Command+Q',
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('pinloom');
  tray.setContextMenu(buildTrayMenu());
  // Left-click opens the window (right-click shows the menu by default).
  tray.on('click', showWindow);
}

// ── app lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  // When macOS auto-launches us at login as a hidden login item, start the
  // backend + tray but don't pop the window — stay quietly in the menu bar.
  const launchedHidden = app.getLoginItemSettings().wasOpenedAsHidden === true;
  void createWindow({ show: !launchedHidden });
});

app.on('second-instance', () => {
  showWindow();
});
// Dock click (macOS) — reveal the (possibly hidden) window.
app.on('activate', () => showWindow());

// Resident: closing the last window does NOT quit. The app stays in the menu
// bar with its backend running until the user explicitly quits.
app.on('window-all-closed', () => {
  // intentionally empty — see Tray "Quit"
});

// Tear the sidecar down with the app, but HOLD the quit until the child is
// actually gone — otherwise Electron can exit before the backend flushes its
// own shutdown (PTYs, claude TUIs, MCP children, SQLite WAL), orphaning that
// whole tree and leaving :4788 + the DB locked for the next launch. SIGTERM
// first (graceful, server.ts has a 3s budget), SIGKILL as a hard fallback.
app.on('before-quit', (e) => {
  app.isQuitting = true;
  const child = backendChild;
  if (!child) return; // connect mode (or nothing spawned) — just quit
  if (child.__pinloomKilling) return; // teardown already in flight
  child.__pinloomKilling = true;
  e.preventDefault();
  const force = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    app.exit(0);
  }, 3500);
  child.once('exit', () => {
    clearTimeout(force);
    app.exit(0);
  });
  child.kill('SIGTERM');
});
