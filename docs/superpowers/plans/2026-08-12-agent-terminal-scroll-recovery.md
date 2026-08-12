# Agent Terminal Scroll Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex/Claude terminal sessions reopen at the latest output and expose a reliable Pinloom `Jump to latest` control when the user scrolls upward.

**Architecture:** Keep dock visibility unmounting, but make reconnect deterministic: Codex launches in normal-buffer inline mode, the first WebSocket attach uses the measured xterm grid, the route sends one mandatory replay frame and buffers boundary output, and a small scroll controller owns follow-bottom state. `AgentTerminal` uses that controller to settle replay/fit events and render a shared accessible jump action.

**Tech Stack:** TypeScript strict mode, React 19, xterm.js 5.5, Fastify WebSocket, Vitest, Playwright, pnpm.

## Global Constraints

- Codex fresh and resume launches include `--no-alt-screen` exactly once before any subcommand or positional prompt.
- Do not force `tui.raw_output_mode` and do not alter Claude launch arguments.
- Initial grid query accepts only an atomic pair: cols 20-1000 and rows 5-500; invalid or missing pairs fall back to 120x40.
- Every successful agent-terminal attach emits one replay frame, including an empty snapshot, before buffered/live output.
- Output between snapshot capture and replay delivery is delivered exactly once in FIFO order.
- Replay write completion alone owns initial bottom settlement; the safety timeout releases input suppression only.
- User scroll-up disables follow-bottom; live output and fits do not pull the user down until they return or activate the button.
- Alternate buffers never show a nonfunctional Pinloom jump button.
- No migration or dependency addition.
- Preserve unrelated and pre-existing uncommitted changes. Do not commit in this shared dirty worktree.
- Code and comments are English and contain no issue/ticket numbers.

---

### Task 1: Codex inline launch and deterministic agent-terminal attach

**Files:**
- Create: `packages/backend/src/services/codex-pty/launch-spec.test.ts`
- Create: `packages/backend/src/services/agent-terminal-protocol.ts`
- Create: `packages/backend/src/services/agent-terminal-protocol.test.ts`
- Modify: `packages/backend/src/services/codex-pty/launch-spec.ts`
- Modify: `packages/backend/src/app.ts`

**Interfaces:**
- Produces `parseAgentTerminalGrid(query: { cols?: unknown; rows?: unknown }): { cols: number; rows: number }`.
- Produces `createReplayFirstOutput(onSend): { onData(data): void; deliverReplay(snapshot): void; close(): void }`; `deliverReplay` sends `{ t: 'o', d: snapshot, replay: true }`, flips delivery state, and flushes FIFO ordinary output.
- Existing `attachCodexTerminal` and `attachAgentTerminal` signatures remain unchanged.

- [ ] **Step 1: Add RED launch tests**

  Create isolated temporary `HOME`/`CODEX_HOME` fixtures and assert fresh/resume argv contain one `--no-alt-screen`; assert it precedes `resume` and the native session id; assert model/reasoning/seed ordering, generated trust/MCP TOML, and stable home behavior remain unchanged.

- [ ] **Step 2: Add RED protocol tests**

  Cover valid bounds `(20,5)`, `(1000,500)`, ordinary measured grids, and atomic `120x40` fallback for missing, partial, decimal, zero, negative, oversized, and string-noise inputs. Cover empty/non-empty replay, output buffered before replay, FIFO flush, post-replay direct delivery, close dropping buffered/future output, and exactly-once `deliverReplay` behavior.

- [ ] **Step 3: Run focused RED tests**

  Run `pnpm --filter @pinloom/backend test -- src/services/codex-pty/launch-spec.test.ts src/services/agent-terminal-protocol.test.ts`. Expected: missing helper/module and missing launch flag failures only.

- [ ] **Step 4: Implement minimal launch and protocol helpers**

  Add `--no-alt-screen` to the global Codex argv before `resume`. Implement strict decimal-string grid parsing with the exact bounds and default pair. Implement a connection-local FIFO whose replay delivery is idempotent and whose closed state drops all data.

- [ ] **Step 5: Wire `/ws/agent-terminal`**

  Parse `cols`/`rows` from the query, create the replay-first output gate before `attach`, pass its `onData` callback into `attach`, call `deliverReplay(handle.buffer)` on success even when empty, and close the gate on attach failure/socket close. Keep replay first and boundary output lossless.

- [ ] **Step 6: Run GREEN verification**

  Run the two focused tests, backend typecheck, and the existing Codex terminal integration test. Run `git diff --check`.

- [ ] **Step 7: Write task report**

  Record RED/GREEN commands, exact changed interfaces, config/argv ordering, replay boundary invariants, and concerns in `.superpowers/sdd/2026-08-12-agent-terminal-scroll-recovery/task-1-report.md`. Do not commit.

---

### Task 2: Shared xterm follow-bottom controller and jump control

**Files:**
- Create: `packages/frontend/src/components/agent-terminal-scroll.ts`
- Create: `packages/frontend/src/components/agent-terminal-scroll.test.ts`
- Modify: `packages/frontend/src/components/AgentTerminal.tsx`
- Modify: `packages/frontend/src/i18n/strings.ts`

**Interfaces:**
- Produces `TerminalViewportSnapshot` with `bufferType`, `viewportY`, and `baseY`.
- Produces pure state/actions for `settled`, `replaying`, `following`, and `showJump` decisions; callback/timeout settlement ownership is explicit and testable without a DOM.
- `AgentTerminal` remains agent-neutral and receives no new agent prop.

- [ ] **Step 1: Add RED controller tests**

  Assert normal `viewportY < baseY` is away from bottom, equality/greater is bottom, alternate is ineligible, unsettled hides the action, user scroll-up clears following, natural return/jump restores it, fits preserve bottom only while following, timeout releases input without settling, and a later replay callback settles exactly once.

- [ ] **Step 2: Run focused RED test**

  Run `pnpm --filter @pinloom/frontend test -- src/components/agent-terminal-scroll.test.ts`. Expected: missing helper/module failures only.

- [ ] **Step 3: Implement the pure controller**

  Keep state transitions immutable and framework-independent. Validate numeric snapshots defensively and treat malformed snapshots as ineligible rather than showing a stale button.

- [ ] **Step 4: Wire initial grid and mandatory replay settlement**

  Make `safeFit()` return success. Include measured query params only on success. Start each connection unsettled; for the mandatory replay frame call `term.write(msg.d, callback)` even for empty data. Add a replay input-suppression safety timer that never consumes the callback-owned viewport settlement.

- [ ] **Step 5: Wire scroll/fits/live writes**

  Subscribe to `term.onScroll`, inspect `term.buffer.active.type/viewportY/baseY`, and update the controller. After replay callback call `scrollToBottom()` once. For safe/open/font-ready/late/ResizeObserver/font-size fits, capture follow intent and restore bottom only when it was active. Recompute buffer eligibility after every live write callback without forcing bottom.

- [ ] **Step 6: Render the shared accessible control**

  Add localized en/ko/zh `Jump to latest` copy. Render an `ArrowDown` button only for open, settled, normal-buffer, away-from-bottom state. Use at least a 32px target, semantic theme tokens, visible focus ring, bottom-center placement, `aria-label`, and terminal refocus after activation.

- [ ] **Step 7: Run GREEN verification**

  Run the focused controller test, all frontend tests, i18n key check if present, frontend typecheck/build, repository typecheck, and `git diff --check`.

- [ ] **Step 8: Write task report**

  Record state-machine invariants, replay timeout/callback behavior, fit paths audited, RED/GREEN results, and visual limitations in `.superpowers/sdd/2026-08-12-agent-terminal-scroll-recovery/task-2-report.md`. Do not commit.

---

### Task 3: Scroll lifecycle browser regression

**Files:**
- Create: `e2e/agent-terminal-scroll.spec.ts`
- Create: `e2e/agent-terminal-scroll.config.ts`
- Modify only if required for a test seam: `packages/frontend/src/components/AgentTerminal.tsx`

**Interfaces:**
- Browser test intercepts `/ws/agent-terminal` with Playwright WebSocket routing and supplies deterministic mandatory replay/live frames; production behavior is not gated by test environment flags.

- [ ] **Step 1: Build a deterministic WebSocket fixture**

  Seed a project and terminal-transport session through isolated test APIs. Intercept the agent-terminal socket, record initial URL grid parameters, send a normal-buffer replay longer than the viewport, and support controlled live output. Never invoke a real Claude/Codex binary in the test.

- [ ] **Step 2: Add RED lifecycle assertions**

  Assert initial replay settles at bottom without jump-button flicker, manual upward scroll shows the accessible control, live output preserves the read position, activation reaches bottom/hides the control/refocuses xterm, and repeated session-tab round trips return at bottom.

- [ ] **Step 3: Cover layout timing**

  Trigger panel/rail resize and reconnect; verify bottom anchoring survives. Record `.xterm-viewport` metrics (`scrollTop`, `scrollHeight`, `clientHeight`) and assert within a one-pixel bottom tolerance.

- [ ] **Step 4: Run isolated browser GREEN**

  Run `pnpm exec playwright test --config e2e/agent-terminal-scroll.config.ts`. Confirm it uses a temporary DB and does not reuse a running server.

- [ ] **Step 5: Write task report**

  Record fixture protocol, browser metrics, repeated round-trip count, and any difference between normal/alternate buffer simulation in `.superpowers/sdd/2026-08-12-agent-terminal-scroll-recovery/task-3-report.md`. Do not commit.

---

### Task 4: Scroll recovery verification

**Files:**
- Modify only to fix regressions found by verification.

- [ ] **Step 1: Run repository verification**

  Run backend tests, frontend tests, repository typecheck, available lint/i18n checks, production build, new isolated Playwright test, existing smoke test, and `git diff --check`.

- [ ] **Step 2: Manual Codex/Claude verification**

  With real installed Codex 0.147, generate more than one viewport, scroll up, activate the button, switch sessions repeatedly, resize the side rail, and reconnect. Repeat with Claude terminal. Check light/dark themes and supported dock positions.

- [ ] **Step 3: Write final report**

  Summarize automated/manual evidence, unresolved upstream xterm limitations, and rollback boundaries in `.superpowers/sdd/2026-08-12-agent-terminal-scroll-recovery/final-report.md`. Do not commit.
