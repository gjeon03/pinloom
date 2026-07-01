# pinloom

[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md)

Local Claude Code workspace. Persistent history, pinned answers, project Wiki, Teams orchestration, GitHub-backed backup.

![pinloom workspace](docs/screenshots/05-project-workspace.png)

## Download

Want the app without building from source?

**[⬇ Download pinloom for macOS (Apple Silicon)](https://github.com/gjeon03/pinloom/releases/latest)**

Unsigned build — on first launch, right-click the app → **Open** (or **System
Settings → Privacy & Security → Open Anyway**). Still needs the Claude Code CLI
installed and logged in. Prefer to build it yourself? See [Quick start](#quick-start)
and [`packages/desktop`](packages/desktop/README.md).

## Why

Claude Code's CLI is great but loses session context across `~/.claude/` resets, SDK upgrades, and machine moves. pinloom keeps the conversation, the per-project notes, and the team setup in its own local SQLite + filesystem so they survive all of that.

## What you get

- **Persistent conversation history.** Every message and tool call is
  mirrored to pinloom's own SQLite, so `~/.claude/` resets, SDK
  version bumps, and machine moves never lose history.
- **Pinned answers.** Right-click an assistant message → "Pin". It
  docks to the side panel and stays visible while you keep chatting,
  so the one-liner you actually need stops scrolling 200 messages
  out of view.
- **Persistent Wiki the agent reads on every turn.** Per-project +
  cross-project markdown notes at `~/.pinloom/wiki/`. Sync from chat
  sessions, analyze a codebase for conventions, or edit pages
  in-place with a live preview.
  → [docs/features/wiki.md](docs/features/wiki.md)
- **Environment variables, registered once.** Settings → Environment
  Variables. Every Claude/Codex agent run inherits them. No more
  `~/.bashrc` edits per integration.
  → [docs/features/env-vars.md](docs/features/env-vars.md)
- **Teams — orchestrator + workers via MCP.** Group one orchestrator
  session with N workers; the orchestrator dispatches by alias
  (`@be`, `@fe`) or by tag (broadcast). Synchronous `team_ask`
  mirrors the SDK's Task tool so the orchestrator's turn stays alive
  across the round trip.
- **GitHub-backed backup.** Push your wiki tree to a private repo
  with one click, restore on another machine. Database lives off the
  git side as a portable JSON export/import so it survives across
  laptops without bloating the repo with binary diffs.
- **Local-only.** No auth, no cloud, no multi-user. Runs on
  `localhost:4747` on your machine.

| | |
|---|---|
| ![env vars](docs/screenshots/03-env-var-add-form.png) | ![wiki](docs/screenshots/06-wiki-populated.png) |
| **Env vars** — registered once, inherited by every agent run | **Wiki** — persistent project memory the agent reads on every turn |

## Stack

- **Runtime**: Node.js (required by `@anthropic-ai/claude-agent-sdk`)
- **Backend**: Fastify + `@fastify/websocket` + `better-sqlite3`
- **Frontend**: React 19 + Vite + Tailwind CSS v4
- **Monorepo**: pnpm workspaces

## Requirements

- **Node.js ≥ 22** (Node 24 LTS recommended). Version pins are checked in
  for both `nvm` (`.nvmrc`) and `asdf` (`.tool-versions`). Use whichever
  version manager you prefer — or skip if your system Node already meets
  the requirement.
- **pnpm** (enable via `corepack enable` if you don't have it)
- **At least one agent CLI** installed and authenticated locally:
  - **Claude Code CLI** — `claude --version` should work
  - **Codex CLI** (optional alternative) — `codex --version` should work

  Sessions can use either agent; pick per-session in the UI. Install whichever
  you have access to.

## Quick start

```bash
pnpm install
pnpm start           # build + run, http://localhost:4747
```

### Developing pinloom itself

```bash
pnpm dev             # tsx watch + Vite HMR — for editing pinloom's source
```

`pnpm dev` adds source-file watchers and is heavier; use `pnpm start` for daily
use.

## Design principles

1. **Sessions are owned by pinloom, not Claude Code.** All messages and tool_use blocks are mirrored to the local SQLite DB, so `~/.claude/` resets never lose conversation history.
2. **The agent's memory lives on disk you control.** Wiki under `~/.pinloom/wiki/`, sessions under `data/pinloom.sqlite`. Both can be backed up to GitHub or exported as files.
3. **Explicit deletion only.** No session, page, or plan is auto-purged — web UI actions remove data.
4. **Local-only MVP.** No auth, no cloud, no multi-user. Run on your machine.

## Layout

```
packages/
  shared/      # types, constants, zod schemas
  backend/     # Fastify app, SQLite, WS hub, claude-agent-sdk runner
  frontend/    # React UI: chat / wiki / teams / settings
  mcp-server/  # pinloom MCP tools for the Teams orchestrator
docs/
  features/    # deep-dives on individual features
  screenshots/ # committed UI screenshots for the README + features docs
e2e/
  smoke.spec.ts        # CI smoke test
  walkthrough.spec.ts  # regenerates docs/screenshots/ + a .webm walkthrough
```

## Regenerating the screenshots + demo video

The screenshots in `docs/screenshots/` and the walkthrough video at
`docs/walkthrough.webm` are produced by a Playwright spec:

```bash
pnpm exec playwright test --config e2e/walkthrough.config.ts
cp e2e/artifacts/screenshots/*.png docs/screenshots/
cp e2e/artifacts/walkthrough.webm docs/walkthrough.webm
```

The walkthrough:

- Spawns a fresh backend + frontend on `localhost:4747` with a throwaway
  SQLite under `$TMPDIR` and an overridden `$HOME` — it never touches
  `data/pinloom.sqlite` or your real `~/.pinloom/`.
- Pre-fetches a real Claude answer via the local `claude` CLI before the
  test starts (so the recording isn't a blank tab waiting on the SDK),
  inserts the Q+A via direct SQLite, and pins the assistant message via
  the public `PATCH /api/messages/:id` route.
- Seeds three wiki pages on disk so the Wiki dashboard captures real
  content instead of an empty state.

Requires the host's `claude` CLI to be authenticated — the SDK's
bundled native binary picker prefers a musl build that doesn't run on
glibc Linux, so we shell out to the system CLI instead.

## License

MIT
