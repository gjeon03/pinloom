// pinloom desktop shell — connect-or-spawn.
//
// Two ways to run:
//  • CONNECT: a pinloom is already up locally (the developer's launchd keeps
//    backend:4748 + frontend:4747 alive). The window just loads that, exactly
//    like Phase 1 — no second backend, no second DB.
//  • SPAWN: nothing is running (a colleague who only has the .app). We start the
//    backend ourselves as a child process via Electron-as-node, told to serve
//    BOTH the API and the built frontend on one port (PINLOOM_SERVE_STATIC),
//    with its data in the app's userData dir. claude/codex CLIs still come from
//    the user's PATH — those can't be bundled.
const { app, BrowserWindow, shell, dialog } = require('electron');
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

let backendChild = null;

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
    fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
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
    process.env.PINLOOM_STATIC_DIR ||
    path.join(process.resourcesPath, 'app-frontend')
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
  const dbPath =
    process.env.PINLOOM_DB_PATH || path.join(app.getPath('userData'), 'pinloom.sqlite');

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
    // Only a clean, unsignalled non-zero exit is a real crash. A signalled exit
    // (code === null, e.g. our SIGTERM/SIGKILL on quit) is expected teardown,
    // never a crash dialog.
    if (!app.isQuitting && signal == null && code !== 0) {
      dialog.showErrorBox('pinloom', `Backend exited unexpectedly (code ${code}).`);
      app.quit();
    }
  });
  // If the user quit while we were still deciding/probing, before-quit already
  // ran (with no child to kill); tear this just-spawned one down immediately so
  // it can't be orphaned.
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
  backendChild = spawnBackend();
  return `http://localhost:${SIDECAR_PORT}`;
}

// ── window ───────────────────────────────────────────────────────────────────
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
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.on('close', () => saveState(win));

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

  const target = await resolveTarget();
  // Poll up to ~60s for the target to answer (cold launchd boot, or our just-
  // spawned sidecar warming up native modules + migrations).
  for (let i = 0; i < 60; i++) {
    if (win.isDestroyed()) return win;
    if (await isUp(`${target}/api/ping`)) break;
    await sleep(1000);
  }
  if (!win.isDestroyed()) await win.loadURL(target);
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

// Tear the sidecar down with the app, but HOLD the quit until the child is
// actually gone — otherwise Electron can exit before the backend flushes its
// own shutdown (PTYs, claude TUIs, MCP children, SQLite WAL), orphaning that
// whole tree and leaving :4788 + the DB locked for the next launch. SIGTERM
// first (graceful, server.ts has a 3s budget), SIGKILL as a hard fallback.
app.on('before-quit', (e) => {
  if (app.isQuitting) return;
  app.isQuitting = true;
  const child = backendChild;
  if (!child) return; // connect mode (or nothing spawned) — just quit
  e.preventDefault();
  const force = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    app.quit();
  }, 3500);
  child.once('exit', () => {
    clearTimeout(force);
    app.quit();
  });
  child.kill('SIGTERM');
});
app.on('window-all-closed', () => app.quit());
