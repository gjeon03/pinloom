# Claude SDK Chat History Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load only the latest 100 Claude SDK chat messages initially and prepend older pages without changing live chat, search navigation, or scroll position.

**Architecture:** Add a backward cursor route alongside the compatible full-list route, then move ChatView history mutations into a pure reducer with live-revision conflict resolution. Bind it to Virtuoso inverse scrolling through a stable positive index origin and a single older-page request controller.

**Tech Stack:** TypeScript strict mode, Fastify 5, better-sqlite3, React 19, SWR 2, react-virtuoso 4, Vitest 4, Playwright 1.59, pnpm 10.

## Global Constraints

- Preserve all existing uncommitted user changes; never revert, delete, or overwrite unrelated work.
- Do not create commits; the user did not explicitly request commits.
- Use named exports and 2-space indentation; prefer `const` and never use `var`.
- Do not add or upgrade dependencies.
- Source code comments must not contain issue or ticket numbers.
- Keep `GET /api/sessions/:sessionId/messages` and `api.listMessages()` unchanged for terminal side-panel callers.
- The new endpoint is exactly `/api/sessions/:sessionId/messages/page` with default 100, minimum 1, maximum 500.
- Pages are chronological ascending, exclude `source_message_id IS NOT NULL`, and use strict `(created_at, rowid)` backward ordering.
- Invalid cursors return HTTP 400 and never fall back to the newest page.
- `VIRTUAL_INDEX_ORIGIN` is exactly `1_000_000_000`; underflow is a visible recoverable error, never a clamp.
- A reducer-wide monotonic live revision is stamped on each WebSocket-mutated message; page snapshots cannot overwrite a newer live mutation.
- Older-scroll and focus-target loads share one request controller and cursor.
- No messages are deleted, rewritten, or permanently hidden.
- Deployment requires focused tests, full backend/frontend suites, repository typecheck, production build, isolated browser smoke, final independent review, and `git diff --check`.

---

### Task 1: Backward Message Page API

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/backend/src/routes/sessions.ts`
- Modify: `packages/backend/src/routes/sessions.test.ts`
- Modify: `packages/frontend/src/api/client.ts`
- Modify: `packages/frontend/src/api/cacheKeys.ts`

**Interfaces:**
- Produces: shared `MessagePage { items: Message[]; nextCursor: string | null }`.
- Produces: `api.listMessagePage(sessionId: string, opts?: { before?: string; limit?: number }): Promise<MessagePage>`.
- Preserves: existing full-list API/client function unchanged.

- [ ] **Step 1: Add failing route tests**

  Insert at least 205 source messages plus mirror rows. Test latest 100 ascending, two older cursor pages with no gaps/duplicates, identical timestamps ordered by rowid, `limit=1`, `limit=500`, invalid/out-of-range limits, strict cursor validation, cross-session cursor scope, empty/unknown sessions, and exclusion of mirror rows.

- [ ] **Step 2: Run RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/routes/sessions.test.ts
  ```

  Expected: 404 or missing response type because the page route does not exist.

- [ ] **Step 3: Implement cursor helpers and route**

  Encode exact `{ createdAt: string, rowid: number }` JSON as base64url. Decode with exact keys, non-empty string timestamp, and positive safe integer rowid. Query eligible rows using:

  ```sql
  AND (created_at < ? OR (created_at = ? AND rowid < ?))
  ORDER BY created_at DESC, rowid DESC
  LIMIT ?
  ```

  Request `limit + 1`, compute `nextCursor` from the oldest returned item when lookahead exists, and reverse returned rows. Validate query plan before adding an index; add no migration unless measurement proves one is needed.

- [ ] **Step 4: Add shared/client contracts**

  Add the named shared type, page client method, and newest-page cache key. Construct search params only for supplied values.

- [ ] **Step 5: Run GREEN**

  Run route tests, shared build, backend/frontend typecheck, and scoped `git diff --check`.

### Task 2: Chat History Reducer and Virtuoso Pagination

**Files:**
- Create: `packages/frontend/src/components/chat-history.ts`
- Create: `packages/frontend/src/components/chat-history.test.ts`
- Modify: `packages/frontend/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: Task 1 `MessagePage` and `api.listMessagePage`.
- Produces: `VIRTUAL_INDEX_ORIGIN`, initial state factory, reducer/actions, page merge helpers, focus load state.

- [ ] **Step 1: Add failing reducer tests**

  Cover latest initial page, older prepend, duplicate page, equal-ID refresh, reducer-wide request/live revisions, stream chunk during refresh, message update during refresh, stale session generation, tool-group merge changing render delta, underflow error, failed older request retry, and focus state transitions.

- [ ] **Step 2: Run RED**

  Run:

  ```bash
  pnpm --filter @pinloom/frontend test -- src/components/chat-history.test.ts
  ```

  Expected: module/export failures.

- [ ] **Step 3: Implement the pure reducer**

  Keep messages ordered/deduped by ID, one reducer-wide `liveRevision`, per-message live revision map, page cursor/loading/error, focus state, generation, and `firstItemIndex`. Compare the render-item count before/after prepend using the exported grouping helper so tool groups at a page boundary produce the correct delta.

- [ ] **Step 4: Wire latest-page SWR and live events**

  Replace ChatView's full-list SWR fetch with newest-page SWR. Initial response replaces the empty generation; reconnect/Refresh merges the newest page using request-start revision. Route WebSocket append/update/chunk actions through the reducer. Preserve queue/run/attachment/model state and existing errors.

- [ ] **Step 5: Wire inverse older loading**

  Add `firstItemIndex` and `startReached` to Virtuoso. One callback owns the in-flight cursor request, prepends successful pages, and leaves the cursor retryable on failure. Update numeric scroll targets to absolute indices; preserve `LAST` and bottom-follow behavior.

- [ ] **Step 6: Wire focus-target paging**

  If a requested target is absent, drive the approved state machine using 500-row pages through the shared controller. Retry only on Refresh or another explicit goto event. Clear the focus marker after the target jump is scheduled or history is exhausted.

- [ ] **Step 7: Run GREEN**

  Run the focused test, complete frontend suite, frontend build, repository typecheck, and scoped `git diff --check`.

### Task 3: Browser Regression and Final Integration

**Files:**
- Create or modify: dedicated Playwright config/spec under `e2e/` for Claude SDK pagination.

**Interfaces:**
- Consumes: Task 1 page API and Task 2 ChatView behavior.
- Produces: isolated browser regression using temporary SQLite/test mode and no real Claude CLI invocation.

- [ ] **Step 1: Add browser fixtures**

  Start backend/frontend on dedicated strict ports with `PINLOOM_TEST_MODE=1`, a temporary SQLite path, and `reuseExistingServer: false`. Seed more than 200 SDK messages through a deterministic fixture route or database setup. Mock agent execution and CLI health checks; never invoke a real Claude binary.

- [ ] **Step 2: Test initial and older loading**

  Assert the newest page renders first and the view lands at bottom. Scroll to the top, wait for an older page network response, and assert the same anchor message remains within a small pixel tolerance.

- [ ] **Step 3: Test live and navigation behavior**

  While scrolled up, inject a live message and assert viewport stability plus Jump to latest. Navigate to a search target older than the initial page and assert it loads and receives focus. Switch sessions and back and assert no previous-session flash.

- [ ] **Step 4: Run final integration checks**

  Run the dedicated Playwright spec, existing smoke E2E, complete backend/frontend suites, `pnpm typecheck`, `pnpm build`, and `git diff --check`. Confirm dedicated ports/processes are stopped afterward.
