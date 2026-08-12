# Codex Session Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long Codex terminal sessions responsive, expose live context pressure, and let the user continue in a fresh linked Codex thread through a bounded checkpoint without deleting the source history.

**Architecture:** Preserve the existing incremental rollout and bounded scrollback work, then derive Codex context telemetry from appended rollout events into SQLite and broadcast it to the session UI. A rollover service obtains one exclusive visible checkpoint turn from the live source terminal and only then creates a fresh linked session, copied pins, and checkpoint pin in one transaction. The frontend renders a Codex-only context row and reuses `ProjectPage.onHandoff()` to open the destination terminal tab.

**Tech Stack:** TypeScript strict mode, Node.js 22, Fastify 5, better-sqlite3, React 19, SWR, Vitest 4, Playwright 1.59, pnpm 10, Electron Builder.

## Global Constraints

- Preserve all existing uncommitted user changes; never revert or delete them.
- Do not create commits; the user did not explicitly request commits.
- Use named exports except existing Next.js page/layout exceptions; use 2-space indentation and `const` wherever reassignment is unnecessary.
- Do not add or upgrade dependencies.
- Source code comments must not contain issue or ticket numbers.
- Do not delete or rewrite Pinloom messages, SQLite data, Codex homes, or rollout files.
- Only `event_msg:context_compacted` increments the observed compaction count; top-level `compacted` records are ignored.
- After a compaction signal, the next positive valid `last_token_usage.input_tokens` becomes the post-compaction baseline; zero and malformed samples leave the pending baseline set, including across backend restarts.
- Existing sessions are not historically rescanned or backfilled; telemetry is unavailable until a new valid token event is observed.
- Severity thresholds are exact: normal below 75%, elevated from 75% to below 90%, critical at or above 90%, unavailable without valid tokens and a positive context window.
- The checkpoint prompt requests no more than 12,000 Unicode code units. Responses at or below 16,000 code units are preserved; longer responses retain the first 12,000 and last 4,000 with an explicit omission marker.
- Rollover is manual only. Missing, busy, bot-owned, team-owned, timed-out, failed, or empty checkpoint requests create no destination session.
- Destination creation, copied pins, and checkpoint persistence are one SQLite transaction; broadcasts occur only after commit.
- The destination inherits project, plan, Codex agent, model, reasoning effort, and terminal transport; `source_session_id` points to the source and both native resume identifiers are `NULL`.
- The source session, pins, resume identifiers, and Codex home remain unchanged. Its transcript and `updated_at` may advance through the visible final checkpoint turn.
- UI strings for this feature must exist in English, Korean, and Chinese.
- Deployment runs only after typecheck, all unit tests, production build, isolated Playwright smoke, final code review, and working-tree secret/unintended-file review pass.

---

### Task 1: Finalize Incremental Rollout and Scrollback Foundations

**Files:**
- Modify: `packages/backend/src/services/scrollback.ts`
- Test: `packages/backend/src/services/scrollback.test.ts`
- Modify: `packages/backend/src/services/terminal.ts`
- Modify: `packages/backend/src/services/claude-pty/agent-terminal.ts`
- Modify: `packages/backend/src/services/codex-pty/agent-terminal.ts`
- Modify: `packages/backend/src/services/codex-pty/rollout-tail.ts`
- Test: `packages/backend/src/services/codex-pty/rollout-tail.test.ts`
- Modify: `packages/backend/src/services/codex-pty/transcript-capture.ts`

**Interfaces:**
- Consumes: existing `CodexRolloutLine`, append-only JSONL rollout files, and the current 200 KiB terminal scrollback contract.
- Produces: `createScrollback(maxBytes: number): Scrollback`; `readRolloutDelta(file: string, offset: number): RolloutDelta` where `RolloutDelta` adds `fileSizeBytes: number | null`; backward-compatible JSON cursor `{ l, t, b }` in `sessions.last_captured_transcript_uuid`.

- [x] **Step 1: Record and protect the pre-existing work**

  Capture `git status --short` in the task report before editing. Treat all listed modified and untracked files as user-owned starting work. Do not normalize unrelated comments or formatting.

- [x] **Step 2: Add a failing exact-file-size test**

  Extend `rollout-tail.test.ts` with a case equivalent to:

  ```ts
  it('reports the physical file size while retaining an incomplete trailing line', () => {
    const complete = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`;
    const partial = '{"type":"event_msg"';
    writeFileSync(file, complete + partial);

    const delta = readRolloutDelta(file, 0);

    expect(delta.lines).toHaveLength(1);
    expect(delta.offset).toBe(Buffer.byteLength(complete));
    expect(delta.fileSizeBytes).toBe(Buffer.byteLength(complete + partial));
  });
  ```

- [x] **Step 3: Run the focused test and confirm the new assertion fails**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/codex-pty/rollout-tail.test.ts
  ```

  Expected before implementation: failure because `fileSizeBytes` is absent or incorrect. Existing incremental-read, partial-line, malformed-line, truncation, and legacy-prefix tests must remain green apart from the new assertion.

- [x] **Step 4: Complete the bounded scrollback and incremental reader implementation**

  Keep `Scrollback` byte-bounded without repeated whole-buffer concatenation/slicing. Make every `readRolloutDelta()` return carry the `fstatSync()` result as `fileSizeBytes`; use `null` only when the file cannot be opened or statted. Preserve these invariants:

  ```ts
  export interface RolloutDelta {
    lines: CodexRolloutLine[];
    lineEnds: number[];
    offset: number;
    fileSizeBytes: number | null;
    truncated: boolean;
  }
  ```

  The offset advances only past complete newlines, malformed lines follow the current cursor semantics, a shorter file returns `truncated: true`, and the transcript capture never reads the complete rollout on a normal poll.

- [x] **Step 5: Verify foundation behavior**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/scrollback.test.ts src/services/codex-pty/rollout-tail.test.ts
  pnpm --filter @pinloom/backend typecheck
  ```

  Expected: all focused tests pass with clean output and backend strict typecheck exits 0.

- [x] **Step 6: Self-review without committing**

  Confirm no poll path calls `readFileSync()` on an active rollout, terminal buffers remain capped at 200 KiB, legacy integer cursors still migrate once, and no existing WIP was discarded. Write changed files and RED/GREEN evidence to the task report; do not commit.

---

### Task 2: Persist and Broadcast Codex Context Telemetry

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/backend/src/db/migrations.ts`
- Test: `packages/backend/src/db/migrations.test.ts`
- Create: `packages/backend/src/services/codex-context.ts`
- Test: `packages/backend/src/services/codex-context.test.ts`

**Interfaces:**
- Consumes: `CodexRolloutLine[]`, `RolloutDelta.fileSizeBytes`, `getDb()`, and `broadcast(channel, event)`.
- Produces: shared `CodexContextState`; shared `WsEvent` member `{ type: 'codex_context_updated'; sessionId: string; context: CodexContextState }`; `getCodexContextState(sessionId: string): CodexContextState`; `observeCodexContext(sessionId: string, lines: CodexRolloutLine[], rolloutBytes: number | null): CodexContextState | null`.

- [x] **Step 1: Add failing migration coverage**

  Append migration test assertions for migration 41 equivalent to:

  ```ts
  const columns = tableInfo(db, 'codex_context_state');
  expect(columns).toEqual(expect.arrayContaining([
    'session_id',
    'input_tokens',
    'cached_input_tokens',
    'context_window_tokens',
    'observed_compactions',
    'post_compaction_input_tokens',
    'rollout_bytes',
    'awaiting_post_compaction',
    'updated_at',
  ]));
  ```

  Also insert a project/session/context row, delete the session, and assert the telemetry row cascades away.

- [x] **Step 2: Add failing reducer and persistence tests**

  In `codex-context.test.ts`, cover these exact event sequences:

  ```ts
  const validToken = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 193800, cached_input_tokens: 120000 },
        model_context_window: 258400,
      },
    },
  } satisfies CodexRolloutLine;
  const canonicalCompact = {
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  } satisfies CodexRolloutLine;
  const compactNoise = { type: 'compacted', payload: { replacement_history: [] } }
    satisfies CodexRolloutLine;
  ```

  Assertions must prove: no row reports `available: true` before a valid token; the valid token stores input/cache/window/rollout bytes; `compactNoise` does not increment; `canonicalCompact` increments once and sets the durable pending flag; zero/malformed samples keep it pending; the next positive sample records the baseline and clears it; a newly loaded service after that sequence observes the persisted values; duplicate identical observations do not broadcast.

- [x] **Step 3: Run tests and confirm RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/db/migrations.test.ts src/services/codex-context.test.ts
  ```

  Expected before implementation: failure because migration 41, the shared types, and telemetry service do not exist.

- [x] **Step 4: Add migration 41 and shared DTOs**

  Append one migration with this schema:

  ```sql
  CREATE TABLE IF NOT EXISTS codex_context_state (
    session_id                    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    input_tokens                  INTEGER,
    cached_input_tokens           INTEGER,
    context_window_tokens         INTEGER,
    observed_compactions          INTEGER NOT NULL DEFAULT 0,
    post_compaction_input_tokens  INTEGER,
    rollout_bytes                 INTEGER,
    awaiting_post_compaction      INTEGER NOT NULL DEFAULT 0,
    updated_at                    TEXT NOT NULL
  );
  ```

  Add a shared external DTO that does not expose `awaiting_post_compaction`:

  ```ts
  export interface CodexContextState {
    sessionId: string;
    available: boolean;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    contextWindowTokens: number | null;
    observedCompactions: number;
    postCompactionInputTokens: number | null;
    rolloutBytes: number | null;
    updatedAt: string | null;
  }
  ```

- [x] **Step 5: Implement ordered event reduction and persistence**

  `observeCodexContext()` must walk lines in order, accept only finite non-negative integer counts, require positive input/window values for availability and baseline capture, and catch its own database/broadcast errors so telemetry cannot fail transcript capture. Upsert changed state and broadcast only when externally meaningful fields change. A compaction-only observation may create an unavailable row with count 1 and durable pending state.

  `getCodexContextState()` returns this empty shape when no row exists:

  ```ts
  {
    sessionId,
    available: false,
    inputTokens: null,
    cachedInputTokens: null,
    contextWindowTokens: null,
    observedCompactions: 0,
    postCompactionInputTokens: null,
    rolloutBytes: null,
    updatedAt: null,
  }
  ```

- [x] **Step 6: Verify telemetry service behavior**

  Run:

  ```bash
  pnpm build:shared
  pnpm --filter @pinloom/backend test -- src/db/migrations.test.ts src/services/codex-context.test.ts
  pnpm typecheck
  ```

  Expected: migration, reducer, persistence, cascade, and event-shape tests pass; repository typecheck exits 0.

- [x] **Step 7: Self-review without committing**

  Confirm the service never scans history, never treats top-level `compacted` as canonical, persists the pending baseline state, and emits no secret/raw rollout payload. Write RED/GREEN evidence to the report; do not commit.

---

### Task 3: Connect Telemetry to Incremental Capture and the Session API

**Files:**
- Modify: `packages/backend/src/services/codex-pty/transcript-capture.ts`
- Test: `packages/backend/src/services/codex-pty/transcript-capture.test.ts`
- Modify: `packages/backend/src/routes/sessions.ts`
- Test: `packages/backend/src/routes/sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 `RolloutDelta.fileSizeBytes`; Task 2 `observeCodexContext()` and `getCodexContextState()`.
- Produces: `GET /api/sessions/:sessionId/codex-context`; a capture integration path that observes every appended delta before message folding and survives telemetry errors.

- [x] **Step 1: Add a deterministic one-poll test seam and failing capture tests**

  Export a testable one-shot function rather than relying on intervals:

  ```ts
  export async function pollCodexCaptureOnce(pinloomSessionId: string): Promise<void> {
    await poll(pinloomSessionId);
  }
  ```

  Test with a temporary rollout and seeded session that a `token_count` without `task_complete` updates context immediately, that `context_compacted` followed by a valid token in the same delta captures the baseline in event order, and that a forced telemetry persistence error still allows the same delta's user/assistant turn to persist.

- [x] **Step 2: Add failing route tests**

  Register `sessionRoutes()` on a test Fastify instance and assert:

  ```ts
  expect(await app.inject({
    method: 'GET',
    url: '/api/sessions/missing/codex-context',
  })).toMatchObject({ statusCode: 404 });
  ```

  A present session without telemetry returns status 200 with `available: false`; a populated state returns the exact shared DTO and never includes `awaiting_post_compaction`.

- [x] **Step 3: Run tests and confirm RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/codex-pty/transcript-capture.test.ts src/routes/sessions.test.ts
  ```

  Expected before implementation: missing one-shot integration/API behavior causes failure.

- [x] **Step 4: Observe telemetry at the delta boundary**

  In `poll()`, immediately after a successful `readRolloutDelta()` and before turn folding, call:

  ```ts
  observeCodexContext(
    pinloomSessionId,
    delta.lines,
    delta.fileSizeBytes,
  );
  ```

  Keep this operation isolated from transcript persistence. Truncated/replaced rollout recovery must retain its existing cursor reset behavior; it must not trigger a historical full-file telemetry backfill.

- [x] **Step 5: Add the initial-state endpoint**

  The route first checks the session row, returns 404 when absent, and otherwise returns `getCodexContextState(sessionId)`. It performs no agent launch, rollout lookup, or historical scan.

- [x] **Step 6: Verify capture/API integration**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/codex-pty/transcript-capture.test.ts src/routes/sessions.test.ts src/services/codex-context.test.ts
  pnpm typecheck
  ```

  Expected: token-only updates, ordered compaction baseline, telemetry-failure isolation, unavailable response, populated response, and 404 tests pass.

- [x] **Step 7: Self-review without committing**

  Confirm telemetry processing is proportional only to appended lines, route reads are O(1) by primary key, and an observation failure cannot suppress `task_complete`, dispatch waiters, or messages. Write evidence to the report; do not commit.

---

### Task 4: Generate a Checkpoint and Create a Transactional Fresh Session

**Files:**
- Modify: `packages/backend/src/services/codex-pty/agent-terminal.ts`
- Modify: `packages/backend/src/services/codex-pty/transcript-capture.ts`
- Test: `packages/backend/src/services/codex-pty/agent-terminal.integration.test.ts`
- Create: `packages/backend/src/services/codex-rollover.ts`
- Test: `packages/backend/src/services/codex-rollover.test.ts`
- Modify: `packages/backend/src/routes/sessions.ts`
- Test: `packages/backend/src/routes/sessions.test.ts`

**Interfaces:**
- Consumes: live Codex terminal session/capture, `submitToTui()`, `awaitCodexTurn()`, `isAiRunning()`, `isExecRunning()`, team membership queries, and shared `Session` conversion conventions.
- Produces: `requestCodexTerminalCheckpoint(sessionId: string, prompt: string, signal: AbortSignal, timeoutMs?: number): Promise<CodexDispatchResult>`; `isCodexTerminalBusy(sessionId: string): boolean`; `rolloverCodexSession(sessionId: string, dependencies?: CodexRolloverDependencies): Promise<Session>`; `POST /api/sessions/:sessionId/rollover`.

- [x] **Step 1: Add failing live-terminal exclusivity tests**

  Extend the Codex terminal integration test to prove: a missing terminal returns an error without spawning one; a human turn in flight returns busy; a dispatch lock returns busy; checkpoint injection sets `terminal_lock.locked=true`, blocks human writes, waits for the matching next completed turn, then unlocks; timeout and abort also unlock; capture completion resets `turnInFlight`.

  Pass a completion callback when capture starts:

  ```ts
  startCodexCapture(sessionId, launch.codexHome, launchInput.resume, () => {
    created.turnInFlight = false;
  });
  ```

- [x] **Step 2: Add failing rollover service tests**

  Inject a deterministic checkpoint provider and cover all of these cases:

  ```ts
  interface CodexRolloverDependencies {
    requestCheckpoint?: (
      sessionId: string,
      prompt: string,
      signal: AbortSignal,
      timeoutMs: number,
    ) => Promise<CodexDispatchResult>;
  }
  ```

  - missing source: 404-class error;
  - non-Codex, non-terminal, bot, orchestrator, and worker: 400-class error;
  - AI run, shell run, terminal turn, or terminal lock busy: 409-class error;
  - a concurrent second rollover for the same source: 409 while the first is pending;
  - timeout, checkpoint provider failure, whitespace-only reply: no destination row;
  - reply length 16,000: exact preservation;
  - reply length 16,001: first 12,000 + marker + final 4,000;
  - successful destination inherits project/plan/agent/model/reasoning effort/terminal transport/order, links the source, has both resume IDs null, copies pins in order, and adds a pinned assistant message titled `Rollover checkpoint`;
  - a temporary SQLite trigger that fails checkpoint insertion rolls back the destination and copied pins after checkpoint generation.

- [x] **Step 3: Add failing rollover route tests**

  Assert `POST /api/sessions/:sessionId/rollover` returns the created `Session`, maps validation errors to 400, missing to 404, busy/duplicate to 409, and terminal/checkpoint failure to a non-success response without a destination. Use an injected service seam; do not start the real Codex CLI in route tests.

- [x] **Step 4: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/codex-pty/agent-terminal.integration.test.ts src/services/codex-rollover.test.ts src/routes/sessions.test.ts
  ```

  Expected before implementation: missing checkpoint dispatch, rollover service, and route behavior causes failure.

- [x] **Step 5: Implement exclusive checkpoint dispatch**

  Reuse the existing per-session dispatch chain, but reject rather than cold-start or queue when the source terminal is missing or busy. Recheck `turnInFlight` and `lockedBy` inside the serialized section before setting the lock, arm `awaitCodexTurn()` before `submitToTui()`, and release the lock in `finally`.

  `isCodexTerminalBusy()` returns true for a live `turnInFlight` or any non-null terminal lock. The capture callback resets the human turn flag at both normal and stalled completion boundaries.

- [x] **Step 6: Implement the fixed checkpoint prompt and deterministic bounding**

  Define one exported prompt containing these headings and the 12,000-code-unit instruction:

  ```text
  Current objective and progress
  Decisions and constraints
  Changed files and relevant commands
  Open work and next action
  Failures, gotchas, and verification state
  ```

  Trim the reply; reject empty output. For overlong output, use the exact marker:

  ```text

  <!-- checkpoint middle omitted by Pinloom -->

  ```

- [x] **Step 7: Implement preconditions and transactional creation**

  Protect the whole asynchronous operation with an in-memory `Map<string, Promise<Session>>`, returning 409 for a second in-flight request and removing the entry in `finally`. Recheck source eligibility before checkpoint generation. After a successful checkpoint, execute one `db.transaction()` that:

  ```sql
  INSERT INTO sessions
    (id, project_id, plan_id, agent, claude_session_id, agent_session_id,
     title, order_index, source_session_id, model, reasoning_effort, transport,
     created_at, updated_at)
  VALUES (?, ?, ?, 'codex', NULL, NULL, ?, ?, ?, ?, ?, 'terminal', ?, ?)
  ```

  Use `${source.title} (continued)` when the source has a title and `Continued session` otherwise. Copy the pre-existing source pins with `source_message_id`, then insert the bounded checkpoint as a pinned assistant message titled `Rollover checkpoint`. Broadcast copied/checkpoint messages and `session_created` only after the transaction commits.

- [x] **Step 8: Add the route and verify backend behavior**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/codex-pty/agent-terminal.integration.test.ts src/services/codex-rollover.test.ts src/routes/sessions.test.ts
  pnpm --filter @pinloom/backend test
  pnpm typecheck
  ```

  Expected: focused tests and the complete backend suite pass with clean output; strict repository typecheck exits 0.

- [x] **Step 9: Self-review without committing**

  Confirm no destination exists before a complete non-empty checkpoint, all locks/maps clear in `finally`, broadcasts happen post-commit, no Codex home is removed, and native resume identifiers remain null. Write RED/GREEN evidence to the report; do not commit.

---

### Task 5: Render Context Health and Continue Fresh in the Terminal Rail

**Files:**
- Create: `packages/frontend/src/components/codex-context.ts`
- Test: `packages/frontend/src/components/codex-context.test.ts`
- Create: `packages/frontend/src/components/CodexContextRow.tsx`
- Modify: `packages/frontend/src/components/TerminalSidePanel.tsx`
- Modify: `packages/frontend/src/components/dock/panels.tsx`
- Modify: `packages/frontend/src/api/client.ts`
- Modify: `packages/frontend/src/api/cacheKeys.ts`
- Modify: `packages/frontend/src/i18n/strings.ts`
- Test: `packages/frontend/src/i18n/coverage.test.ts`

**Interfaces:**
- Consumes: shared `CodexContextState`, `codex_context_updated` WS events, `GET /codex-context`, `POST /rollover`, and existing `onHandoff(newSession: Session)`.
- Produces: `getCodexContextSeverity(context: CodexContextState): 'unavailable' | 'normal' | 'elevated' | 'critical'`; `formatTokenCount(value: number): string`; a Codex-terminal-only context row with initial hydration, WS updates/reconnect recovery, confirmation, duplicate-submit prevention, and destination tab opening.

- [x] **Step 1: Add failing pure formatting and severity tests**

  Create tests equivalent to:

  ```ts
  expect(getCodexContextSeverity(state(74, 100))).toBe('normal');
  expect(getCodexContextSeverity(state(75, 100))).toBe('elevated');
  expect(getCodexContextSeverity(state(89, 100))).toBe('elevated');
  expect(getCodexContextSeverity(state(90, 100))).toBe('critical');
  expect(getCodexContextSeverity(state(null, 100))).toBe('unavailable');
  expect(getCodexContextSeverity(state(10, 0))).toBe('unavailable');
  expect(formatTokenCount(258400)).toBe('258.4k');
  ```

- [x] **Step 2: Run the focused frontend test and confirm RED**

  Run:

  ```bash
  pnpm --filter @pinloom/frontend test -- src/components/codex-context.test.ts
  ```

  Expected before implementation: module/functions are missing.

- [x] **Step 3: Implement pure context presentation helpers**

  Calculate ratio only when `available`, `inputTokens` is non-null, and `contextWindowTokens > 0`. Percentage display clamps only visually at a minimum of 0, not at 100, so over-window observations remain honest. Format token counts deterministically with at most one decimal below one million and compact `m` formatting above it.

- [x] **Step 4: Add API methods, cache key, and localized strings**

  Add:

  ```ts
  getCodexContext: (sessionId: string) =>
    request<CodexContextState>(`/api/sessions/${sessionId}/codex-context`),
  rolloverSession: (sessionId: string) =>
    request<Session>(`/api/sessions/${sessionId}/rollover`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  ```

  Add `cacheKeys.codexContext(sessionId)` and complete `cmp.codexContext.*` strings in `en`, `ko`, and `zh` for unavailable, tracked compactions, post-compaction baseline, continue fresh, checkpoint explanation, confirm, cancel, working, and error labels.

- [x] **Step 5: Implement `CodexContextRow`**

  The component accepts:

  ```ts
  interface CodexContextRowProps {
    sessionId: string;
    context: CodexContextState;
    onHandoff?: (session: Session) => void;
    onError: (message: string | null) => void;
  }
  ```

  `TerminalSidePanel` owns the state: hydrate once with `api.getCodexContext()`, update its existing session WebSocket callback from `codex_context_updated`, and re-fetch through that subscription's `onReconnect`. Pass the current state into `CodexContextRow`. This avoids opening a second WebSocket for the same visible panel. Render percentage and absolute values, observed compactions with tracked wording, and optional baseline. Elevated and critical states get progressively prominent borders/backgrounds but never trigger rollover automatically.

  `Continue fresh` first opens an inline localized confirmation explaining the final checkpoint turn. Confirmation sets local `rollingOver`, disables both duplicate confirmation and action buttons, calls `api.rolloverSession()`, then calls `onHandoff(created)`. Failure clears `rollingOver`, keeps the source panel open, and passes the error to `onError`.

- [x] **Step 6: Integrate only for Codex terminal sessions**

  Add a `showCodexContext?: boolean` prop to `TerminalSidePanel`. `TerminalPanel` passes:

  ```tsx
  showCodexContext={session.agent === 'codex' && session.transport === 'terminal'}
  ```

  `ChatPanel` omits it. Render the row between the expanded panel header and tab bodies; the existing collapsed rail stays compact and reveals the row when expanded. Reuse `onHandoff`; do not change `ProjectPage.onHandoff()` or dock layout behavior.

- [x] **Step 7: Verify frontend and localization**

  Run:

  ```bash
  pnpm build:shared
  pnpm --filter @pinloom/frontend test -- src/components/codex-context.test.ts src/i18n/coverage.test.ts src/i18n/t.test.ts
  pnpm --filter @pinloom/frontend test
  pnpm typecheck
  ```

  Expected: severity boundaries, formatting, translation coverage, all frontend tests, and strict repository typecheck pass.

- [x] **Step 8: Self-review without committing**

  Confirm Claude and SDK rails make no telemetry request, WS reconnect rehydrates state, source errors do not create/open tabs, buttons are accessible by visible text and `aria-label`, and the existing handoff path opens exactly one terminal tab. Write RED/GREEN evidence to the report; do not commit.

---

## Final Review, Verification, and Authorized Deployment

These steps are controller-owned after all five task gates pass. They are not delegated to an implementation worker.

- [x] Dispatch one broad read-only reviewer using `requesting-code-review/code-reviewer.md` against this plan and the complete working-tree diff, including pre-existing rollout/scrollback work.
- [x] Resolve all Critical and Important findings with one scoped fix worker, then run one scoped re-review. Record any non-blocking Minor findings in the SDD ledger.
- [x] Run formatting/diff checks:

  ```bash
  git diff --check
  git status --short
  git diff --stat
  ```

  Inspect every changed/untracked path. Reject `.env`, credential, key, token, generated database, rollout, build-output, DMG, and unrelated files from the release diff.

- [x] Run the full verification gate:

  ```bash
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm test:e2e
  ```

  All commands must exit 0. The Playwright config must use its isolated temporary SQLite database with `PINLOOM_TEST_MODE=1` and must not touch the user's production DB.

- [x] Deploy the desktop app using the authorized existing mechanism:

  ```bash
  pnpm --filter @pinloom/desktop run deploy:app
  ```

  This packages the arm64 DMG, quits the running Pinloom app, replaces `/Applications/pinloom.app`, clears quarantine, and relaunches it. Do not run a GitHub release, tag, force push, or source-history mutation.

- [x] Verify deployment:

  ```bash
  test -d /Applications/pinloom.app
  pgrep -fl '/Applications/pinloom.app|pinloom' || true
  ```

  Confirm the application exists and was relaunched. Report the deployed artifact path, verification results, remaining non-blocking findings, and that user SQLite/Codex rollout data were not removed.
