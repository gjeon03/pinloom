# planloom

Plan-first AI workspace. Local open-source tool.

## Quick start

```bash
pnpm install
pnpm dev             # backend (3300) + frontend (5273)
pnpm dev:backend     # backend only
pnpm dev:frontend    # frontend only
```

## Architecture

- **Monorepo**: pnpm workspaces (`packages/shared`, `packages/backend`, `packages/frontend`)
- **Backend**: Fastify + `@fastify/websocket` + `better-sqlite3`
- **Frontend**: React 19 + Vite + Tailwind CSS v4
- **AI runner**: `@anthropic-ai/claude-agent-sdk` (uses local Claude Code CLI auth)

## Core concepts

- **Project**: a directory on disk + its associated plans/sessions.
- **Plan**: a structured, hierarchical document of plan items. First-class object.
- **PlanItem**: one node in the plan (title, body, status). Chat messages and runs attach here.
- **Session**: a conversation with the AI scoped to a project (optionally pinned to a plan item).
- **Message**: stored in planloom's SQLite. Mirrors what the SDK streams. Survives `~/.claude/` resets.

## Design rules

1. Plan is the source of truth. Diffs/logs/chat hang off plan items.
2. planloom's SQLite owns the conversation history. Do not depend on `~/.claude/projects/*.jsonl`.
3. No auto-deletion. Sessions/plans/messages only go away via explicit user action.
4. Local-only. No auth, no multi-user, no cloud sync in MVP.

## Build & verify

```bash
pnpm build           # shared → backend → frontend
pnpm typecheck       # tsc -b
```

## Conventions

- TypeScript strict mode, ESM only
- Named exports (React components too)
- 2-space indent (JS/TS/JSON/YAML)
- DB: SQLite WAL mode, `data/planloom.sqlite`
