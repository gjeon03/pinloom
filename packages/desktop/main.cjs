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

const CONNECT_URL = process.env.PINLOOM_DESKTOP_CONNECT_URL || 'http://localhost:4747';
const SIDECAR_PORT = Number(process.env.PINLOOM_DESKTOP_SIDECAR_PORT) || 4788;
const FORCE_SPAWN = process.env.PINLOOM_DESKTOP_FORCE_SPAWN === '1';
// Cap on rapid back-to-back backend restarts. Reset after the backend stays
// healthy for STABLE_MS, so this bounds a tight crash LOOP, not lifetime crashes.
const MAX_BACKEND_RESTARTS = 5;
const STABLE_MS = 60_000;

let mainWindow = null;
let tray = null;
let trayOk = false;
let backendChild = null;
let backendRestarts = 0;
let respawnTimer = null; // pending crash-respawn (cleared on quit)
let stableTimer = null; // resets the restart counter once the backend is healthy
// True only once a real quit is requested (Tray Quit / Cmd-Q / before-quit), so
// window-close can distinguish "hide to tray" from "actually exiting".
app.isQuitting = false;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
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
    if (win && !win.isDestroyed() && win.isNormal()) {
      fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
    }
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
// user-controlled place. Overridable via PINLOOM_DB_PATH (tests / custom dir).
function canonicalDbPath() {
  return (
    process.env.PINLOOM_DB_PATH || path.join(os.homedir(), '.pinloom', 'data', 'pinloom.sqlite')
  );
}

// A GUI app launched from Finder inherits only a minimal PATH (/usr/bin:/bin:
// …), so a user-installed `claude`/`codex` (npm-global, Homebrew, asdf) is
// invisible to the spawned backend. Resolve the user's real login-shell PATH.
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
    // `-lc` (login, NOT interactive): sources the profile for PATH without `-i`,
    // which can source an rc that prints banners or blocks on a prompt and hang
    // us until the timeout. asdf/Homebrew are also in the fallback below.
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

// If we're about to spawn against a fresh canonical DB but a wiki already exists
// (= this user has used pinloom before), warn that their existing database may
// live elsewhere and isn't migrated yet — otherwise an empty DB looks like data
// loss. Colleagues (no wiki) never see this. Shown synchronously, first run only.
function warnIfDataElsewhere(dbPath) {
  try {
    if (fs.existsSync(dbPath)) return true;
    const wiki = path.join(os.homedir(), '.pinloom', 'wiki');
    if (!fs.existsSync(wiki)) return true; // fresh install — nothing to migrate
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'pinloom',
      message: 'No database found at ~/.pinloom/data',
      detail:
        'pinloom found a wiki but no database here. If you have an existing ' +
        'pinloom database (e.g. from a launchd-served setup at <repo>/data/' +
        'pinloom.sqlite), quit and migrate it first — see the desktop README ' +
        '(scripts/migrate-db.mjs). Otherwise pinloom starts with a fresh, empty ' +
        'database.',
      buttons: ['Start fresh', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 1) {
      app.quit();
      return false;
    }
  } catch {
    // dialog failure must not block startup
  }
  return true;
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
  if (!warnIfDataElsewhere(dbPath)) return null; // user chose to quit & migrate
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {
    // backend surfaces a clearer error if the dir is truly unwritable
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
      PINLOOM_MCP_BACKEND_URL: `http://localhost:${SIDECAR_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.on('exit', (code, signal) => {
    if (backendChild === child) backendChild = null;
    // A pending "stayed healthy" reset is moot now — cancel it.
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    if (app.isQuitting) return; // expected teardown
    if (signal == null && code === 0) return; // clean voluntary exit (unexpected)
    if (backendRestarts < MAX_BACKEND_RESTARTS) {
      backendRestarts += 1;
      const delay = Math.min(1000 * backendRestarts, 5000);
      console.error(
        `[backend] exited (code ${code}, signal ${signal}) — restarting in ${delay}ms ` +
          `(${backendRestarts}/${MAX_BACKEND_RESTARTS})`,
      );
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        if (app.isQuitting) return;
        ensureBackend();
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
  return child;
}

// Single choke point for owning the backend: never spawns a second one while
// one is already tracked (prevents an untracked, un-killable backend), assigns
// `backendChild` synchronously, and arms a timer to reset the restart counter
// once the backend has stayed up long enough to count as healthy.
function ensureBackend() {
  if (app.isQuitting) return null;
  if (backendChild) return backendChild;
  const child = spawnBackend();
  backendChild = child;
  if (child) {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      backendRestarts = 0;
    }, STABLE_MS);
  }
  return child;
}

// Decide CONNECT vs SPAWN and return the URL the window should load. Probe
// /api/ping (not /) so we only CONNECT to an actual pinloom backend.
async function resolveTarget() {
  if (!FORCE_SPAWN && (await isUp(`${CONNECT_URL}/api/ping`))) {
    return CONNECT_URL;
  }
  ensureBackend();
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
    // Closing HIDES the window (resident app); only a real quit destroys it. If
    // the tray failed to init we have no other entry point, so allow the close
    // (window-all-closed will then quit).
    if (!app.isQuitting && trayOk) {
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
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit pinloom', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('pinloom');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
}

// ── app lifecycle ─────────────────────────────────────────────────────────────
if (gotTheLock) {
  app.whenReady().then(() => {
    try {
      createTray();
      trayOk = true;
    } catch (e) {
      console.error('[tray] failed to initialize:', e);
      trayOk = false;
    }
    // When macOS auto-launches us hidden at login, start backend + tray but
    // don't pop the window. If the tray failed, always show a window so there's
    // a way to quit.
    const launchedHidden = app.getLoginItemSettings().wasOpenedAsHidden === true;
    void createWindow({ show: !launchedHidden || !trayOk });
  });

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());

  // Resident: closing the last window does NOT quit — UNLESS the tray failed to
  // init, in which case the window is the only entry point and closing it should
  // quit (otherwise the app is unreachable and unquittable).
  app.on('window-all-closed', () => {
    if (!trayOk) app.quit();
  });

  // Tear the sidecar down with the app, holding the quit until the child is
  // actually gone — otherwise Electron can exit before the backend flushes its
  // shutdown (PTYs, claude TUIs, MCP children, SQLite WAL), orphaning that tree
  // and leaving :4788 + the DB locked. SIGTERM (graceful, 3s budget) then
  // SIGKILL fallback.
  app.on('before-quit', (e) => {
    app.isQuitting = true;
    // Cancel any pending respawn so a crashed-then-quitting app can't relaunch a
    // backend we'd then fail to tear down.
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    saveState(mainWindow);
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
}
