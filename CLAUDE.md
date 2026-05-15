# pinloom

Plan-first AI workspace. Local open-source tool.

## Quick start

```bash
pnpm install
pnpm dev             # backend (4748) + frontend (4747)
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
- **Message**: stored in pinloom's SQLite. Mirrors what the SDK streams. Survives `~/.claude/` resets.
- **Team**: groups one **orchestrator** session with N **worker** sessions. The orchestrator addresses workers by `alias` (`@be`, `@fe`) via the pinloom MCP server.
- **Worker `instructions`** (TEXT, ≤ 4000 chars, nullable): system-prompt-style guidance — identity / do's / don'ts / output conventions — injected verbatim into the worker's system prompt every turn.
- **Worker `tags`** (JSON array of lowercase tokens, ≤ 16, alias-style regex): logical groups for broadcast dispatch and visual grouping on the canvas.

## Design rules

1. Plan is the source of truth. Diffs/logs/chat hang off plan items.
2. pinloom's SQLite owns the conversation history. Do not depend on `~/.claude/projects/*.jsonl`.
3. No auto-deletion. Sessions/plans/messages only go away via explicit user action.
4. Local-only. No auth, no multi-user, no cloud sync in MVP.

## Build & verify

```bash
pnpm build           # shared → mcp-server → backend → frontend
pnpm typecheck       # tsc -b
```

The `mcp-server` package is in the build chain because the backend
spawns it as a child process at run time (per orchestrator turn) and
needs the freshly compiled `dist/index.js` to expose the latest set
of MCP tools. **An already-running orchestrator session caches its
tool list at session start** — after rebuilding mcp-server, restart
the orchestrator session (or the whole backend) so the new tools
become visible to the LLM.

## Conventions

- TypeScript strict mode, ESM only
- Named exports (React components too)
- 2-space indent (JS/TS/JSON/YAML)
- DB: SQLite WAL mode, `data/pinloom.sqlite`

## Teams workflow

A team groups one orchestrator chat with N worker chats. The orchestrator
agent (Claude or Codex) is given an MCP server that exposes nine tools
for coordinating the team. Workers are normal chat sessions — they do not
see each other and do not get MCP. Cross-worker synthesis only happens
in the orchestrator.

### MCP tools (orchestrator only)

| Tool | Purpose |
|------|---------|
| `team_list()` | Re-fetch worker status (alias / agent / model / project / running / queued) |
| **`team_ask(alias, text, timeoutMs?)`** | **Default delegation tool.** Sends a prompt and blocks until the worker replies; returns the reply directly as the tool_result. Mirrors the Claude SDK's Task tool — orchestrator turn stays alive across the round trip. Default + max wait 5min. |
| **`team_ask_tag(tag, text, timeoutMs?)`** | Broadcast variant of `team_ask`. Sends to every worker with that tag, waits for all in parallel, returns each reply concatenated. Total wall time ≈ slowest worker. |
| `team_send(alias, text)` | Fire-and-forget alternative to `team_ask`. Returns immediately. Use only when you genuinely want to kick off a long task and continue other work in the same turn. |
| `team_send_tag(tag, text)` | Fire-and-forget broadcast variant. Returns `{recipients[], failures[]}`. |
| `team_update_member(alias, newAlias?, instructions?, tags?)` | Sharpen a worker's role mid-session. Cannot add or remove workers. |
| `team_read(alias, sinceMessageId?, limit?)` | Read a worker's recent messages. `limit` defaults to 20, max 200. |
| `team_status(alias)` | Check a worker's idle / running / queued state. |
| `team_wait(alias, timeoutMs?)` | Block until a worker idles. Used with the async `team_send` pattern; `team_ask` already waits internally. |

### How routing works

The orchestrator's system prompt lists every worker's alias, agent, project, tags, and a 280-char (whitespace-collapsed) summary of `instructions`. The LLM picks alias-vs-tag by **tool name** (`team_ask` vs `team_ask_tag`) — there is no `@tag:foo` sigil grammar. Tag pattern matches alias pattern (`/^[a-z][a-z0-9_-]{0,31}$/`); the tools are intentionally separate so the namespace overlap doesn't matter.

### Default delegation pattern: `team_ask`

`team_ask` mirrors the Claude SDK's Task tool — one tool call = one synchronous round trip with the worker, reply returned as the tool_result. Prefer it over the older `team_send` + `team_wait` + `team_read` triplet. The orchestrator's turn stays alive across the wait, so it can chain follow-up `team_ask` calls (or call them in parallel) and synthesize without ever ending its turn early. `team_send` is now the explicit fire-and-forget escape hatch.

### Known semantics

- **Updates apply on the worker's NEXT turn.** An in-flight worker turn finishes with its old instructions; only the next `runAssistant` rebuilds the system prompt.
- **`instructions: null`** clears (intentional). On the dispatch route, `instructions: ""` is **rejected** with 400 to prevent an LLM accidentally wiping a role; the human PATCH route stays lenient (textarea-empty = clear) to match the UI's `.trim() || null` convention.
- **Adding / removing workers stays in the UI.** PR7 deliberately omitted those from MCP — session creation has too many side effects to expose to an LLM.
- **Per-broadcast canvas events.** `team_send_tag` to N workers emits N `dispatch_send` events with a shared `dispatchedAt` so the canvas animates them as one burst. The ring buffer holds the last 500 events per team.

### Worker-side context

When a worker session runs, its system prompt gains a `## Team role` block iff it has non-empty `instructions` or non-empty `tags`. The full `instructions` text is injected verbatim under `### Instructions` (no truncation — the summary lives only on the orchestrator side); `tags` appear as `Tags: #foo #bar`. Workers without either field (generalist / pre-migration rows) get no extra heading. Workers see `[from orchestrator]` prefixes on dispatched messages so the LLM treats them as lead asks rather than user input.
