# Teams orchestration redesign — dispatch job records + progress events

Status: **design / proposal** (not yet implemented) — **v2, post design-review**

> v2 folds in a multi-agent design review against the live code. The three
> review-blocking gaps (terminal reply authority, boot/delete recovery,
> worker_status double-source) are now first-class in P1 below; see
> **§6 Review findings** for the rationale and file:line evidence.

## Why

Worker orchestration answers three questions: *is the worker busy? what is it
doing? what did it produce?* Today these are answered by polling **heterogeneous,
transport-specific signals** scattered across the codebase:

- SDK workers: the runner's `activeRuns` (`isAiRunning`) + a per-session WS event
  stream (`stream_chunk`, `tool_use` run_log, `turn_complete`).
- Terminal workers (claude PTY): `turnInFlight` + the dispatch write-lock, with
  the reply landing in the `messages` table **asynchronously** via the Stop-hook
  transcript capture.
- Terminal workers (codex PTY): a 500ms rollout-file poll with task_complete
  boundaries.

The team tools (`team_status`/`team_wait`/`team_read`) read these directly, so:

- `team_status`/`team_wait` only knew the SDK signal → terminal workers always
  looked idle (fixed in #110 by folding the dispatch lock in, but that's another
  per-tool special-case).
- `team_read` reads `messages` directly → races the async capture (empty/stale).
- `team_ask` hard-caps at 5 min (`MAX_WAIT_MS`); there's no handle to reconnect a
  longer task.
- The orchestrator gets **binary running/idle**, never "what is the worker doing"
  (the SDK event stream exists but isn't surfaced to the team layer; the terminal
  transcript/rollout is tailed only post-turn).

The fix is to stop polling scattered flags and make a **dispatch** a first-class,
uniform job record with a lifecycle and a progress event stream — the same model
across SDK and terminal workers.

## Non-goals (deliberately out of scope)

These are cloud-isms or pinloom-design-moot; not built here:

- **Tool-confirmation / `requires_action`** — pinloom runs `permissionMode:
  bypassPermissions`, there is no confirmation round-trip.
- **Outcome/rubric grader loops** — belongs at the orchestrator-prompt level (or a
  later, separate feature).
- **`outputs` as a first-class artifact API** — terminal workers write to the
  local project cwd; the files are already on disk.
- **Hierarchical / multi-agent sub-threads** — that's issue #70, an orthogonal
  feature on top of this substrate.

## Design

### 1. The dispatch job record (durable, SQLite)

New table `dispatches`. One row per orchestrator→worker turn.

```
id                     TEXT PRIMARY KEY            -- nanoid; the handle
team_id                TEXT NOT NULL
worker_session_id      TEXT NOT NULL
orchestrator_session_id TEXT                       -- nullable (canvas/manual)
idempotency_key        TEXT                        -- nullable; dedupe (see §4)
prompt                 TEXT NOT NULL
state                  TEXT NOT NULL               -- queued|running|done|failed|timeout|cancelled
stop_reason            TEXT                         -- end_turn|error|aborted|null (local subset)
reply                  TEXT                         -- captured worker reply (authority = the transcript capture, see §2); nullable until it lands
error                  TEXT                         -- on failed/timeout
last_progress          TEXT                         -- nullable; coarse "last tool / last text" summary (filled in P2, column added now to avoid a 2nd migration)
created_at TEXT, started_at TEXT, ended_at TEXT, updated_at TEXT
```

Indexes: `(worker_session_id, created_at DESC)` for "the worker's latest dispatch";
partial `UNIQUE (team_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

**No FK to `sessions`.** `worker_session_id` is a plain column, *not* a
`REFERENCES sessions(id) ON DELETE CASCADE`. Closing a worker tab hard-deletes the
session (sessions are ephemeral by design); a dispatch row is an audit/handle record
that must outlive that. A `running` row whose worker session vanished is swept to
`failed` (reason `worker_gone`) by the same boot/reconcile sweep that handles
restarts (§2, "Recovery").

**State machine** (uniform, transport-agnostic):

```
queued ──▶ running ──▶ done        (turn completed; reply stored)
   │           │   └──▶ failed      (worker/dispatch error; error stored)
   │           └──────▶ timeout     (exceeded a hard ceiling while still running)
   └──────────────────▶ cancelled   (orchestrator/human cancelled before/while running)
```

The row is the source of truth **for dispatched work** — `team_wait`/`team_read`
read it instead of the dispatch lock or the `messages` table. **`team_status` stays
a union**, though: a worker is "busy" if it has a non-terminal dispatch *or* the
human is driving it directly. Workers are first-class sessions a human can type into
(`isAiRunning`/terminal lock go true with **no** dispatch row); if `team_status` read
only the dispatch table it would report that worker `idle` — a regression of the
case #110 fixed. So `team_status` = `latest-dispatch-state` ∨ `live-activity
(isAiRunning | terminal lock)`. This is a deliberate, documented union, not the
scattered per-tool special-casing v1 set out to remove — `team_wait`/`team_read`
*do* drop their special-cases; `team_status` keeps exactly one (human-driven).

### 2. Who reports transitions (the only transport-specific code)

A small adapter per worker backend reports into the record + emits progress.

- **SDK worker** (runner): the `runAttempt` event loop already produces
  `text_delta` / `tool_use` / `tool_result` / `turn_complete` / `model`. When the
  session is a worker with an active dispatch, mirror those into:
  - `state: running` on the first event,
  - `dispatch_progress` events (text/tool_use/tool_result/thinking) — **ephemeral**,
  - `state: done` + `reply` (accumulated assistant text) on `turn_complete`.
  This is wiring existing data; near-zero new capture work.

- **Claude terminal worker** (Stop-hook + transcript): `state: running` on lock
  acquire / `turnInFlight`. **Reply authority is the transcript capture, NOT the
  Stop-hook payload.** `dispatchToWorker` returns `payload.lastAssistantMessage ?? ''`
  (`agent-terminal.ts:446,464`), but that field is explicitly unreliable —
  `transcript-capture.ts:206-209`: *"claude's real Stop-hook input doesn't reliably
  carry the reply text"*, which is why history is driven purely by the transcript
  rescan (250ms × up to 40, ~10s). So the dispatch row's `reply` must be filled by
  the **same capture that writes `messages`**, not by the hook payload. Ordering
  (resolves open Q4):
  1. On Stop, set `state: running`→pending-reply and hand `team_ask` the payload
     reply *if non-empty* (fast path — preserves the single round trip).
  2. The transcript rescan, when it lands the assistant block, **backfills**
     `dispatches.reply` and flips `state: done` (this is the authoritative write).
     `team_read(dispatchId)` always returns this, so it never races the capture.
  3. If the payload was empty (the common case per the comment), `team_ask` waits
     on the same terminal-state signal `team_wait` uses (bounded by the dispatch
     ceiling) rather than returning `''`. Still one tool round trip; just sourced
     correctly.

  Progress: extend the transcript tail (the rescan loop already reads the JSONL at
  250ms) to emit `dispatch_progress` for new tool_use/text lines **as the turn
  runs** — this is the one genuinely new piece of capture.

- **Codex terminal worker** (rollout poll): `awaitCodexTurn` resolves the reply →
  `state: done`. The 500ms rollout poll already tracks `function_call` line growth
  → emit `dispatch_progress` from that growth.

**Recovery (boot + session delete) — P1, not optional.** A `running` row whose
producer is gone (backend restarted mid-turn, or the worker session was deleted)
would otherwise strand `team_wait` forever (the WS terminal-state event can never
arrive from a dead process). On backend boot, and when a worker session is deleted,
sweep every non-terminal dispatch for that scope to `failed` with `error` =
`backend_restart` / `worker_gone`. This mirrors the existing queued-message boot
recovery (`message-queue.ts:34`, `listSessionsWithQueuedItems`); dispatch just needs
its own `listNonTerminalDispatches()` sweep at the same startup point.

### 3. Progress events (ephemeral) vs the record (durable)

Split by durability to keep it cheap:

- **Durable (DB):** the `dispatches` row — state + reply + error. This is what
  `team_status`/`team_wait`/`team_read` and the audit/canvas-backfill read. Survives
  restart.
- **Ephemeral (in-memory ring buffer + WS):** fine-grained `dispatch_progress`
  events (per tool call / text chunk). Reuses the existing `team:${teamId}` ring
  buffer (`team-events.ts`, 500/team) — extended with `dispatch_started`,
  `dispatch_progress`, `dispatch_done`/`dispatch_failed` event types alongside the
  current `dispatch_send`/`worker_status`. Not persisted per-event (would be heavy);
  the canvas and a live `team_read --follow` consume them; the final reply is on the
  record.

This gives the orchestrator "what is the worker doing right now" without writing a
row per token.

### 4. Tool mapping

| Tool | Today | Redesigned |
|------|-------|-----------|
| `team_send(alias,text)` | fire-and-forget; status via scattered flags | create dispatch (state=queued→running) **synchronously**; return `dispatchId`. The row *is* the busy reservation (kills the lock-set race that #110 patched). |
| `team_ask(alias,text)` | inject + await reply inline; **5-min hard fail** | create dispatch, await terminal state, return `reply`. **On timeout, return `{state:'running', dispatchId}` (a handle)** instead of failing — orchestrator reconnects later. |
| `team_status(alias)` | `isAiRunning` (+lock after #110) | latest dispatch `state` **∨ live-activity** (human-driven workers have no dispatch row — §1) (+ optional latest progress summary). |
| `team_wait(alias)` | `waitForIdle` (SDK) / lock-poll (#110) | block until the dispatch row reaches a terminal state, woken by the WS event (no scattered 250ms poll). |
| `team_read(alias\|dispatchId)` | read `messages` (races capture) | return the dispatch row's `reply` (written atomically). `dispatchId` form reads any past dispatch. Optional `--follow` tails `dispatch_progress`. |

**Idempotency (§4):** the dedupe column and partial UNIQUE index ship in P1, but the
**key is generated by the mcp-server shim, not the LLM** — an LLM won't reuse a
stable key across a retry, so an LLM-supplied key buys nothing and an auto key over
`(alias + prompt-hash + a short rolling window)` can't tell a deliberate re-send from
a retry. So P1's behaviour is: the column exists, the shim stamps a per-tool-call
nonce (no dedupe yet), and **true retry-dedupe is deferred to whenever the transport
layer below MCP actually retries** (today it doesn't). Documented here so the schema
is forward-compatible without claiming a guarantee P1 doesn't deliver.

**Dispatch-as-handle:** because every send returns a `dispatchId` and the record is
durable, a long task (research, big refactor) is no longer bounded by `team_ask`'s
5-min wall: `team_send` → later `team_status`/`team_wait`/`team_read(dispatchId)`.

### 5. Migration & backward-compat

- Additive `dispatches` table + a forward-only migration (no destructive change).
- The `messages`-table capture stays unchanged (it powers the worker's own chat
  history/UI); the dispatch `reply` is **additionally** mirrored onto the row.
- The `team-events` ring buffer gains event types; existing `dispatch_send` /
  `worker_status` consumers (canvas) keep working.
- Roll out behind the existing team-dispatch routes; tools switch to the record one
  at a time so each step is independently shippable and testable.
- **mcp-server shim changes are in scope and cost an orchestrator restart.** The
  handle return (`{state:'running', dispatchId}`) and `dispatchId` inputs to
  `team_status`/`team_read`/`team_wait` change the *tool signatures*, so
  `packages/mcp-server/src/index.ts` must change alongside the routes. Per CLAUDE.md,
  a running orchestrator caches its tool list at session start — so shipping P1
  requires rebuilding mcp-server **and restarting any live orchestrator** to see the
  new shapes. Keep the additions backward-compatible (new optional args, superset
  return) so an un-restarted orchestrator's existing calls still work.

## Implementation phases (one PR each)

**P1 — durable dispatch record + uniform wait/read + handle.**
The `dispatches` table (incl. `last_progress`/idempotency columns, unused yet), the
per-backend transition reporting (state + reply only, no progress stream yet, reply
sourced per §2), the **boot/delete recovery sweep**, and re-point
`team_wait`/`team_read`/`team_ask`/`team_send` at the row. `team_status` becomes the
documented union (§1). This removes the read-lag race and the 5-min wall, and turns
the #110 reservation lock into the row itself — but **`team_status` keeps one
union** (human-driven workers) and idempotency is schema-only (§4). mcp-server shim
+ orchestrator restart are part of this PR (§5).

**P1 boundary — tag broadcasts (`team_send_tag`/`team_ask_tag`) keep their old
path in P1.** They don't create dispatch records yet: `team_send_tag` doesn't even
inject into terminal TUIs today (a separate pre-existing gap), so recording it would
mean fixing that first. They degrade gracefully — `team_status` still reports
`running` via the union, and `team_ask_tag` still returns inline replies as before.
Folding the broadcasts onto records (and fixing terminal fan-out) is a focused
follow-up, not part of P1's single-worker rewiring.

**P2 — progress event stream ("what is the worker doing").**
Emit `dispatch_progress`: SDK wiring (cheap, data already flows) + the terminal
live-tail (the one substantial new capture — surface transcript/rollout increments
mid-turn). `team_read --follow` + richer canvas. `team_status` can return the latest
progress summary.

**P3 (optional, later) — polish.** stop_reason nuance, progress summaries on status,
`team_wait`-on-any-of (tags). Hierarchical teams (#70) and outcome loops remain
separate features built on this substrate.

## Open questions for review

1. Should `dispatch_progress` be *fully* ephemeral, or should a coarse progress
   summary (last tool / last text) be persisted on the row so a reconnecting
   orchestrator sees "where it got to" without the live stream? **Resolved:** persist
   one `last_progress` summary column (added in P1's schema, filled in P2). The
   column ships now so there's no second migration.
2. Concurrency: a worker runs one dispatch at a time. Queue a second, or reject?
   **Resolved for P1: reject with 409.** Queuing-via-`message_queue` only fits SDK
   workers; terminal workers don't use `message_queue` at all — their serialization
   is `withDispatchLock`'s promise chain (`agent-terminal.ts:66`). Unifying on one
   queue means replacing `dispatchChains` with `state=queued` rows, which is well
   beyond P1's additive scope. P1: one live dispatch per worker, second is a clean
   409; queue unification is a later, separate change.
3. Retention: dispatches accumulate. Cap per worker (e.g. keep last N) or per team,
   pruned on insert? (Leaning: keep last N per worker; configurable. Coupled with the
   no-FK orphan policy in §1 — prune covers both growth and post-delete orphans.)
4. Does re-pointing `team_ask`'s terminal path through the record add latency?
   **Resolved:** see §2's ordering. The fast path (non-empty payload reply) is still
   one round trip; the correctness fix is that an *empty* payload now waits on the
   capture-backed terminal state instead of returning `''`. The row's `reply` and
   the value `team_ask` returns are the same capture-sourced string, so they can't
   diverge.

## Known limitations / accepted caveats (P1)

A second multi-agent review of the *implementation* surfaced these. The reachable
correctness bugs (false-success when a dispatch is superseded; terminal capture
over-capturing a same-ms prior reply; a fire-and-forget terminal reject orphaning a
row; the timeout path synthesizing `running` instead of re-reading) are **fixed**.
These remaining items are inherent to P1's "no prompt↔reply correlation" model and
match limitations the pre-redesign `team_ask` already had — accepted and documented,
not fixed in P1:

- **Interleaved human turn (reply attribution).** A worker is a first-class session a
  human can type into. If a human turn is in flight when a dispatch arrives, the queue
  drain interrupts and *combines* it with the dispatched prompt into one turn (this is
  pre-existing runner behavior). The dispatch's recorded reply is then "the newest
  assistant message since the dispatch started," which may reflect the combined turn.
  The old `team_ask` had the same heuristic; P1 carries it into the record. Clean
  prompt↔reply correlation (tagging the queue item with the dispatch id) is a P2
  improvement.
- **Back-to-back dispatches supersede.** Two `team_send`s to one worker in quick
  succession: the first is `cancelled` (superseded), but its queued prompt may still
  execute (combined into the surviving dispatch's turn). The work isn't lost — it's
  attributed to the newer dispatch — but the superseded handle reports `cancelled`.
  The supersede error says so; the shim tells the orchestrator to re-send if needed.
- **Stuck-turn zombie.** If an SDK turn never emits `turn_complete` and never errors
  (a hung agent), its dispatch stays `running` until the backend restarts (boot sweep)
  or the worker session is deleted (delete sweep) — there's no runtime stale-sweep in
  P1. `team_status` reports it `running`, which is truthful (the turn really is
  unresolved). A periodic ceiling-based reclaim is a P3 polish item.

## 6. Review findings (v2) — what the design review changed

A multi-agent review against the live code (critic + Codex) accepted the direction
(dispatch as a first-class record) but blocked P1-as-v1-wrote-it on three
code-grounded gaps, now folded in above:

1. **Terminal reply authority** — v1 made `state:done`+`reply` "atomic" off the
   Stop-hook payload, but `agent-terminal.ts:446,464` returns
   `payload.lastAssistantMessage ?? ''` and `transcript-capture.ts:206-209` says that
   field is unreliable. Fixed: reply authority is the transcript capture; §2 spells
   out the ordering (open Q4).
2. **Boot/delete recovery** — v1 had no story for a `running` row whose producer
   died, stranding `team_wait` forever. Fixed: §2 "Recovery" sweep + no-FK policy in
   §1, both in P1.
3. **`team_status` double-source** — v1 claimed the row is the *single* source and
   status stops reading `isAiRunning`; that would report a human-driven worker as
   `idle` (regressing #110). Fixed: §1 makes `team_status` an explicit union;
   `team_wait`/`team_read` still de-special-case.

Secondary, also folded in: mcp-server shim + orchestrator-restart cost is now named
in §5; idempotency is honestly scoped to schema-only in §4 (the LLM can't supply a
stable key); the `last_progress` column ships in P1 to avoid a second migration.

Smaller call-outs the review raised that we are **accepting as-is** (not changing the
design): SDK reply via `turn_complete` accumulated text already matches the
`messages` row (post-redact) and is genuinely atomic — the asymmetry with terminal
is real and documented, not a bug. Runner gaining a "dispatch-active?" check is a new
but small coupling (one predicate), accepted as the price of mirroring existing SDK
events with zero new capture.
