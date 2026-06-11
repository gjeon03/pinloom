# Codex terminal-mode parity (Option B) — plan

Make codex a first-class **terminal** agent in terminal mode, at parity with
claude (live TUI in xterm + history/pins capture + teams dispatch). Driven by a
verified research+design+critique workflow (2026-06-11). **Critique verdict: GO —
full Option B feasible, no design changes needed.**

## Hard invariant (non-negotiable)

The **SDK/structured codex path** (`codex-adapter.ts` → `codex exec --json`,
rendered in `ChatView`) stays **100% untouched**, and the **claude terminal path**
(`claude-pty/*`) stays untouched. Codex terminal is a NEW, additive path reachable
only when `transport === 'terminal' && agent === 'codex'`. Untouched files:
`agents/codex-adapter.ts`, all `claude-pty/*`, `ChatView`.

## Verified feasibility (codex-cli 0.133.0, confirmed live)

- **Interactive TUI + seed**: `codex [flags] [PROMPT]` runs the prompt in the TUI
  (like `claude "prompt"`); `codex resume <SESSION_ID> [PROMPT]` for resume. Runs
  in node-pty's real TTY (never headless).
- **No-approval spawn**: `--dangerously-bypass-approvals-and-sandbox` +
  `--dangerously-bypass-hook-trust` (+ `-C <cwd>`, `-c key=value`).
- **Turn-completion signal**: codex `Stop` hook — STABLE (`codex features list`),
  **same schema as claude** (`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"…"}]}]}}`).
  Injected per-session via the temp CODEX_HOME `config.toml` (TOML), not the user's
  `~/.codex/hooks.json`. → the localhost `stop-hook-server` bridge ports verbatim.
- **Capture source**: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
  JSONL but a DIFFERENT shape than claude (`{type:'event_msg'|'response_item',payload:{type:'user_message'|'agent_message'|'task_complete'|…}}`).
  Needs a NEW parser; payload→event mapping ported from `codex-adapter.ts:375-454`.
- **Resume token**: `session_meta.id` / `task_complete.turn_id`; persisted via the
  existing `updateClaudeSessionId()` into `sessions.agent_session_id`. No migration.

## Architecture — `packages/backend/src/services/codex-pty/` (mirrors `claude-pty/`)

| Concern | Reuse / New |
|---|---|
| CODEX_HOME + auth + MCP TOML (`buildCodexHome`, `tomlString`) | reuse logic from `codex-adapter.ts` (duplicate for MVP to keep adapter byte-identical) |
| Forwarder `.mjs` (`launch-spec.ts` FORWARDER_SRC) | reuse verbatim |
| Stop-hook localhost server (`stop-hook-server.ts` + `shared-server.ts`) | reuse (shared singleton) |
| MCP config dict (`buildOrchestratorMcpConfig`) | reuse (render to TOML) |
| `buildSessionLaunchInput` (cwd/prompt/model/effort/resume/mcp) | reuse |
| `updateClaudeSessionId`, `persistMessage`, `signalTurnComplete` | reuse |
| xterm/AgentTerminal/WS/lock overlay/`terminal_relaunch`, `submitToTui` | reuse (extend guard only) |
| `codex-pty/launch-spec.ts` (argv + CODEX_HOME hook block) | NEW |
| `codex-pty/rollout.ts` (discovery + resume token) + `codex-rollout/parse.ts` | NEW (mapping ported) |
| `codex-pty/transcript-capture.ts` | NEW (analog) |
| `codex-pty/agent-terminal.ts` (PTY lifecycle) | NEW (~90% copy of claude's) |
| `dispatchToCodexWorker()` | NEW |
| `codex-pty/completion-signal.ts` (Stop-hook vs rollout-tail) | NEW (insulates the one risky dep) |

codex launch argv: `codex --dangerously-bypass-approvals-and-sandbox
--dangerously-bypass-hook-trust -C <cwd> [--model M] [-c model_reasoning_effort=E]
[resume <threadId>] [<initialText>]`. System prompt: codex has no
`--append-system-prompt` → inject via an instructions file in the temp CODEX_HOME
(codex loads `session_meta.instructions`), else `-c`, else leading injected message
(Phase 1 nails the channel).

## Gating (additive edits to existing files only)

- `app.ts` `/ws/agent-terminal` attach: `if (session.agent === 'codex') attachCodexTerminal(...)` before the claude branch.
- `team-dispatch.ts` `isTerminalWorker` + dispatch: add the `agent==='codex'` arm → `dispatchToCodexWorker`.
- `ProjectPage.tsx`: widen the two `agent==='claude'` terminal guards (L~621 pin-hide, L~648 render) via an `isTerminalSession(s)` helper covering claude OR codex. Structured sessions (`transport!=='terminal'`) of either agent still hit `ChatView`.

## Phase 0 result (DONE — approach refined)

Spike outcome: **completion signal = rollout-tail, NOT the Stop hook.** codex's
hook-trust dialog ("Hooks need review") blocks even with
`--dangerously-bypass-hook-trust` in the interactive TUI, so hooks are out. But
the **rollout file gives a cleaner signal anyway**:

- Spawn `codex --dangerously-bypass-approvals-and-sandbox -C <cwd> "<seed>"` in
  node-pty with a pinloom-controlled `CODEX_HOME` whose `config.toml` pre-trusts
  the cwd: `[projects."<cwd>"]\ntrust_level = "trusted"` (the directory-trust
  analog of claude's `hasTrustDialogAccepted`). Verified: runs the seeded turn
  headless, replies, returns to the input box. **No hooks.json → no hook dialog.**
- **Turn-completion + reply**: the rollout's `event_msg:task_complete` line carries
  `{turn_id, last_agent_message, completed_at, duration_ms}` — a crisp per-turn
  boundary AND the reply text (= claude's `last_assistant_message`). This is the
  `CompletionSignal` (a rollout-tail watcher) and the dispatch reply source.
- **Capture**: the SAME rollout — `session_meta{id,cwd,cli_version,base_instructions}`,
  `event_msg:user_message{message}`, `event_msg:agent_message{message,phase}`,
  `response_item:message` (tool/raw). Filter noise: `token_count`, `turn_context`,
  `task_started`.
- **Rollout location**: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
  Because pinloom owns CODEX_HOME, this is a KNOWN per-session path → **no
  discovery race** (better than claude's shared-dir diff). **Use a STABLE per-session
  CODEX_HOME** (e.g. `~/.pinloom/codex-homes/<sessionId>/`, NOT mkdtemp that's
  cleaned) so the rollout persists for `codex resume <session_meta.id>`.
- **Resume**: `codex resume <id> [seed]`; `id` = `session_meta.id`, persisted via the
  existing `updateClaudeSessionId()` into `sessions.agent_session_id`.
- **stop-hook-server is NOT reused for codex**; replaced by a `rollout-watcher`
  CompletionSignal. (`buildCodexHome`/auth/MCP-TOML still reused.)

## Phases (smallest-risk-first; multi-agent verify + commit per phase)

- [x] **Phase 0 — feasibility spike: DONE.** Completion signal = rollout-tail
  `task_complete`; capture = same rollout; controlled stable CODEX_HOME; dir-trust
  via `config.toml trust_level`. No hooks.
- [ ] **Phase 1 — Launch + raw PTY render (human-only).** `codex-pty/launch-spec.ts` + `agent-terminal.ts` + `app.ts` attach + `ProjectPage` guard. Resolve system-prompt channel. Checkpoint: codex TUI renders in xterm, runs turns, MCP `team_*` visible to a codex orchestrator.
- [ ] **Phase 2 — Capture / persistence.** `rollout.ts` + `codex-rollout/parse.ts` + `transcript-capture.ts` on the `CompletionSignal`. Checkpoint: turns → `messages` rows, resume token persisted, no dupes, side panel + pins work.
- [ ] **Phase 3 — Dispatch.** `dispatchToCodexWorker()` + `team-dispatch` extension. Checkpoint: orchestrator `team_ask`s a codex worker; cold-start + warm-dispatch + tag-broadcast work; busy overlay.
- [ ] **Phase 4 — Hardening + regression.** dedup/teardown/relaunch/caps; `pnpm typecheck`+`build`; rollout-tail fallback test; confirm structured codex + claude terminal untouched.

## Risks (full table in the design output)
- R0 Stop hook may not fire per-turn in alt-screen TUI → Phase 0 gate; fallback rollout-tail (same downstream).
- R1 system-prompt channel (no `--append-system-prompt`) → Phase 1 spike.
- R2 rollout schema drift across codex versions → key off `agent_message`, treat `task_complete` as optimization.
- R6 duplication (agent-terminal/buildCodexHome) → accept for MVP, dedupe later.

## Status
- [x] Phase 0  - [x] Phase 1  - [x] Phase 2  - [x] Phase 3  - [x] Phase 4

## Shipped (supersedes the hook-based design above)

Phase 0 disproved the Stop-hook path: codex's hook-trust dialog blocks the
headless TUI, and `--dangerously-bypass-hook-trust` does NOT skip it. **Pivoted
to rollout-tail** — no hooks, no forwarder, no localhost server. Final shape:

- **launch-spec.ts** — stable per-session `CODEX_HOME` (`~/.pinloom/codex-homes/<id>`,
  0700) so `codex resume` works; `config.toml` pre-trusts the cwd
  (`[projects."<cwd>"] trust_level="trusted"`) + declares MCP servers (TOML); AGENTS.md
  = system prompt; auth.json copied in. argv: `--dangerously-bypass-approvals-and-sandbox
  -C <cwd> [--model …] [-c model_reasoning_effort=…] [resume <id>] [seed]`.
- **codex-rollout/parse.ts** + **codex-pty/rollout.ts** + **transcript-capture.ts** —
  poll the session's rollout JSONL; fold each turn into `messages` at its
  `task_complete` boundary (line-count cursor in `last_captured_transcript_uuid`;
  turnsSeen rehydrated from the cursor prefix since resume APPENDS to the same file).
- **codex-pty/agent-terminal.ts** — PTY lifecycle + `dispatchToCodexWorker`
  (serialized per worker; cold-start seeds via the positional arg, live worker
  injected via `submitToTui`; reply = `task_complete.last_agent_message`).
- Wiring: `app.ts` routes `/ws/agent-terminal` to the codex driver by agent;
  `routes/sessions.ts` DELETE kills + removes the home; `team-dispatch.ts` routes
  terminal dispatch to codex vs claude; `ProjectPage.tsx` renders codex terminal.

Verified live (codex-cli 0.133.0, isolated test DB): cold-start capture
`[user, assistant]`; dispatch returns `{ok:true, reply}`; kill+resume returns the
resumed turn's answer (not a stale reply) with both turns' rows intact. Multi-agent
review: gating PASS (codex-adapter / claude-pty / ChatView untouched), security LOW
(auth dir → 0700, fixed), correctness BLOCKERs (resume baseline, fixed). Backend
suite: 232 passed.
