# @pinloom/desktop

Electron desktop app for pinloom. It runs in one of two modes, decided at launch:

- **Connect** — a pinloom is already serving locally (your `pnpm dev`/`pnpm start`
  or the launchd service on `:4747`). The window just loads it. No second
  backend, no second database.
- **Spawn** — nothing is running (a colleague who only has the `.app`). The app
  starts the backend itself as a child process via *Electron-as-node*, serving
  the API **and** the built frontend on one port (`:4788`), with its data under
  the app's `userData` directory.

`claude` / `codex` are **not** bundled (they can't be) — the user still needs
Claude Code installed and logged in. The app resolves your login-shell `PATH`
before spawning so a Homebrew/npm-global/asdf install is found.

## Develop

```bash
pnpm --filter @pinloom/desktop start          # opens a window onto a running pinloom
# force the spawn path against a locally-built backend:
PINLOOM_DESKTOP_FORCE_SPAWN=1 \
  PINLOOM_BACKEND_ENTRY=$PWD/packages/backend/dist/server.js \
  PINLOOM_STATIC_DIR=$PWD/packages/frontend/dist \
  pnpm --filter @pinloom/desktop start
```

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
2. `pnpm deploy`s the backend into `staging/app-backend` in **copy mode**
   (real files, no hardlinks back to the global pnpm store);
3. electron-rebuilds **only** `better-sqlite3` + `node-pty` for Electron's ABI
   inside that staged copy.

The workspace's shared `node_modules` are **never** rebuilt for Electron's ABI
(`npmRebuild: false`) — doing so would break a running Node backend on its next
restart.

> Native ABI note: better-sqlite3 v12 is Node-API (ABI-stable across Node and
> Electron) and sqlite-vec is a loadable SQLite extension (ABI-independent), so
> only node-pty strictly needs the Electron rebuild. onnxruntime-node (semantic
> search) is imported dynamically and degrade-safe, so it stays Node-ABI and
> simply falls back to lexical FTS if it can't load under Electron.

## Installing the unsigned app (Gatekeeper)

The `.dmg` is **unsigned** (no Apple Developer code-signing). macOS Gatekeeper
will block it on first open. To run it:

1. Drag **pinloom** to Applications, then try to open it once (it will be
   blocked with *"can't be opened because Apple cannot check it…"*).
2. **System Settings → Privacy & Security** → scroll to the message about
   pinloom → **Open Anyway**.

Or, from a terminal, clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/pinloom.app
```

(Signing + notarization is intentionally skipped for personal/colleague
distribution.)
