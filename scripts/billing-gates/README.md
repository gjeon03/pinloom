# billing-gates — 6/15 Agent-SDK billing-split tooling

Scripts that decide and de-risk pinloom's response to the 2026-06-15 Agent-SDK
billing split. Full rationale: [`docs/billing/dual-bucket-plan.md`](../../docs/billing/dual-bucket-plan.md).

**The golden rule (from the 3-agent review): prove the cheaper answer before
building. Run the gates in order; stop as soon as one passes.**

## Run NOW (safe, read-only)

| Script | What |
|---|---|
| `measure-sdk-spend.mjs` | Estimates your last-30-day usage from `~/.claude/projects/**`. Gate-1 input. `node scripts/billing-gates/measure-sdk-spend.mjs --days 30` |

## Run ON/AFTER 2026-06-15 (consume real usage — `PINLOOM_GATE_CONFIRM=1`)

| Order | Script | Decides |
|---|---|---|
| 1 | `measure-sdk-spend.mjs --days 30` | spend < $200? → **stop, PTY unneeded** |
| 2 | `gate2-oauth-bucket.mjs` | OAuth `-p` = interactive bucket? → **stop, build `-p` adapter, no PTY** |
| 3 | `gate3-streamjson-keepalive.mjs` | stream-json keep-alive = interactive bucket? → robust transport, no TUI |
| 4 | `gate4-workload-routing.md` | does routing alone spread the load under both caps? → no PTY |
| — | `integration-real-claude.mjs` | (if PTY needed) does the built PTY transport drive real claude correctly? |

Each gate that fires means **less to build**. Only if all fail does the PTY
transport ship — and its hard parts (`packages/backend/src/services/claude-pty/`,
`claude-jsonl/`) are already built + tested, so wiring is the remaining work.

## What's already built + tested (this branch)

- `claude-jsonl/` — transcript parser + token accounting (also powers issue #21).
- `claude-pty/` — PTY transport: orchestration (mock-tested), Stop-hook server,
  transcript reader, node-pty session factory.
- `mock-claude.mjs` — deterministic fake `claude` for the gated e2e test
  (`PINLOOM_RUN_PTY_INTEGRATION=1 pnpm --filter @pinloom/backend test`).

Not yet wired into `agents/index.ts` (no regression to the live SDK path) — that's
the post-gate step.
