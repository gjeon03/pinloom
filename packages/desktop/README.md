# @pinloom/desktop

Resident macOS desktop app for pinloom. It lives in the **menu bar** and keeps
running (with its backend) even when the window is closed, so background work —
message indexing, work-timeline capture, wiki gardener — keeps going. Closing
the window hides it; the app only really quits from the Tray **Quit** or ⌘Q.

At launch it decides how to reach a backend:

- **Connect** — a pinloom is already serving locally (your `pnpm start` or the
  launchd service on `:4747`). The window just loads it. No second backend, no
  second database.
- **Spawn** — nothing is running (a colleague who only has the `.app`). The app
  starts the backend itself via *Electron-as-node*, serving the API **and** the
  built frontend on one port (`:4788`), with its data in a canonical on-disk
  location (see below). The backend is restarted automatically if it crashes,
  and torn down cleanly on quit.

`claude` / `codex` are **not** bundled (they can't be) — the user still needs
Claude Code installed and logged in. The app resolves your login-shell `PATH`
before spawning so a Homebrew/npm-global/asdf install is found.

## Data location

When the app spawns its own backend, the database lives at
**`~/.pinloom/data/pinloom.sqlite`** — alongside the wiki (`~/.pinloom/wiki`), in
one predictable, user-controlled place. Override with `PINLOOM_DB_PATH`.

### Migrating from the launchd-served setup

If you were running pinloom via `pnpm start` / launchd (DB at
`<repo>/data/pinloom.sqlite`) and want the app to own the data, copy it across
once — **non-destructive**, the source is only read:

```bash
node packages/desktop/scripts/migrate-db.mjs          # repo DB → ~/.pinloom/data
node packages/desktop/scripts/migrate-db.mjs --force  # overwrite target (backs it up first)
```

It uses better-sqlite3's online backup (a consistent snapshot even with an
active WAL) and verifies row counts + integrity before reporting success. After
migrating you can stop/unload the launchd service (`io.pinloom.app`) and let the
app be the single owner.

## Start at login

Tray menu → **Open at Login** toggles a native login item
(`app.setLoginItemSettings`). When macOS auto-launches the app at login it
starts hidden — backend + menu bar only, no window — until you click the Tray
icon.

## Develop

```bash
pnpm --filter @pinloom/desktop start          # opens a window onto a running pinloom
```

This connects to a running pinloom (`:4747`). The **spawn** path can't be
exercised in dev this way: the spawned backend runs under Electron-as-node and
needs Electron-ABI native modules, but the workspace's `node_modules` are
Node-ABI — so spawn is validated against the **packaged** `.app` (which bundles
Electron-ABI modules), not `electron .`.

Env overrides: `PINLOOM_DESKTOP_CONNECT_URL`, `PINLOOM_DESKTOP_SIDECAR_PORT`,
`PINLOOM_DESKTOP_FORCE_SPAWN`, `PINLOOM_BACKEND_ENTRY`, `PINLOOM_STATIC_DIR`,
`PINLOOM_DB_PATH`.

## Build a `.dmg`

```bash
pnpm --filter @pinloom/desktop dmg    # stage + electron-builder → dist-app/*.dmg
```

(Named `dmg`, not `pack`, because `pnpm pack` is a reserved built-in that would
shadow the script.) `dmg` runs `stage.mjs` then `electron-builder`. Staging:

1. builds shared → mcp-server → backend, and the frontend **into `staging/`**
   (not the workspace `dist`, so a live `vite preview` is never disturbed);
2. `pnpm deploy`s the backend into an **out-of-repo** staging tree in copy mode
   (real files, no hardlinks back to the global pnpm store);
3. electron-rebuilds `better-sqlite3` + `node-pty` for Electron's ABI inside
   that staged copy, then asserts they load under Electron and that the
   workspace's better-sqlite3 is still Node-ABI.

The workspace's shared `node_modules` are **never** rebuilt for Electron's ABI
(`npmRebuild: false`, and staging lives outside the repo so electron-rebuild's
project-root walk-up can't reach the workspace) — doing so would break a running
Node backend on its next restart.

> Native ABI note: **better-sqlite3 is NAN / V8-versioned** (NODE_MODULE_VERSION)
> — it MUST be recompiled per ABI (Electron 33 = 130, Node 24 = 137) or it fails
> to load. **node-pty is Node-API** (ABI-stable across Node/Electron); rebuilding
> it is belt-and-suspenders. sqlite-vec is a loadable SQLite extension dylib
> (ABI-independent). onnxruntime-node (semantic search) is imported dynamically +
> degrade-safe, so it stays Node-ABI and falls back to lexical FTS under Electron.

## Installing the unsigned app (Gatekeeper)

The `.dmg` is **unsigned** (no Apple Developer code-signing). macOS Gatekeeper
blocks it on first open. Easiest fix — clear the quarantine attribute from a
terminal:

```bash
xattr -dr com.apple.quarantine /Applications/pinloom.app
```

Or via the UI: try to open the app once (it gets blocked), then **System
Settings → Privacy & Security** → scroll to the message about pinloom → **Open
Anyway** (the button only appears *after* the blocked attempt).

(Signing + notarization is intentionally skipped for personal/colleague
distribution.)
