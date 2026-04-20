# planloom

Plan-first AI workspace. Local-only. Every task starts with a living plan you can tag, chat with, and reshape.

## Why

Most AI coding UIs treat the plan as a throwaway artifact. planloom treats it as a first-class object: you build the plan, tag its items in chat, update it as you learn, and execute items one at a time. Think of it as a loom — weaving plan items into code, one pass at a time.

## Stack

- **Runtime**: Node.js (required by `@anthropic-ai/claude-agent-sdk`)
- **Backend**: Fastify + `@fastify/websocket` + `better-sqlite3`
- **Frontend**: React 19 + Vite + Tailwind CSS v4
- **Monorepo**: pnpm workspaces

## Quick start

```bash
pnpm install
pnpm dev             # backend (3300) + frontend (5273)
```

## Design principles

1. **Plan is the source of truth.** Chat, diffs, and run logs attach to plan items.
2. **Sessions are owned by planloom, not Claude Code.** All messages/tool_use are mirrored to the local SQLite DB, so `~/.claude/` resets never lose conversation history.
3. **Explicit deletion only.** No session/plan is auto-purged — web UI actions remove data.
4. **Local-only MVP.** No auth, no cloud, no multi-user. Run on your machine.

## Layout

```
packages/
  shared/     # types, constants, zod schemas (planned)
  backend/    # Fastify app, SQLite, WS hub, claude-agent-sdk runner
  frontend/   # React UI: Plan panel / Chat panel / Terminal
```

## License

MIT
