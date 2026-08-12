# Claude SDK Chat History Pagination Design

## Goal

Make long Claude SDK conversations open and switch quickly by loading the latest
history window first and fetching older messages only when needed, while keeping
the visible chat, search navigation, live streaming, pins, and history records
functionally unchanged.

Success means:

- initial ChatView hydration transfers at most 100 messages;
- scrolling to the top prepends the next older page without moving the user's
  visible anchor;
- new WebSocket messages and streaming updates continue to appear in order;
- reconnect and manual refresh reconcile the latest page without discarding
  already loaded older pages;
- global search navigation still reaches an older target message by loading
  pages until the target is present;
- terminal side-panel history keeps its existing API and behavior;
- no message is deleted, rewritten, or hidden permanently.

## Evidence

`GET /api/sessions/:sessionId/messages` currently selects every source message
in ascending order. ChatView stores the complete result in React state. Virtuoso
limits mounted DOM rows, but it cannot reduce the HTTP response, JSON parsing,
grouping, or retained message objects.

The current production database contains a session with 11,213 messages. Its
message response is about 11.4 MiB. Loading this payload on every cold session
open is unnecessary because users normally begin at the latest turn.

## Considered approaches

### 1. Keep the full API and render fewer rows

The current Virtuoso implementation already does this. It helps DOM cost but not
network, parsing, grouping, or state memory. Rejected.

### 2. Fetch all messages once and cache them indefinitely

This improves repeat tab switches but preserves the worst first-open allocation
and makes memory scale with every opened long session. Rejected.

### 3. Add a backward cursor API and inverse infinite loading

Serve the newest page in chronological display order, return an opaque cursor
for the preceding page, and prepend on Virtuoso `startReached`. Selected.

## API design

Keep the existing unpaged endpoint unchanged for terminal side-panel history
and other compatibility callers.

Add:

```http
GET /api/sessions/:sessionId/messages/page?limit=100&before=<opaque-cursor>
```

The shared response type is:

```ts
export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}
```

Rules:

- default limit: 100;
- minimum limit: 1;
- maximum limit: 500;
- omitted `before`: newest page;
- `items`: chronological ascending order for direct display;
- `nextCursor`: opaque base64url JSON containing the oldest returned row's
  `created_at` and SQLite `rowid`, or `null` when no older source row exists;
- malformed cursors return HTTP 400 and never fall back to the newest page;
- rows with `source_message_id IS NOT NULL` remain excluded;
- an empty or unknown session returns the same empty-history semantics as the
  existing list endpoint.

The cursor decoder requires exactly a non-empty string timestamp and a positive
safe-integer rowid. Unknown fields, missing fields, invalid base64url, invalid
JSON, and invalid field values return HTTP 400. For a valid cursor the query's
strictly-older predicate is exactly:

```sql
created_at < ? OR (created_at = ? AND rowid < ?)
```

The query orders by `created_at DESC, rowid DESC`, requests `limit + 1`, removes
the extra row, and reverses the selected page before returning it.
`nextCursor` is encoded from the oldest returned eligible row, never the extra
lookahead row. The existing
`(session_id, created_at)` index stores rowid as its implicit tie-breaker, so
equal timestamps preserve database insertion order without exposing rowid in
the public `Message` type. Migration 43 adds an explicit partial paging index
only if query-plan verification shows the existing index cannot serve the
source-row filter and ordering without a material sort; otherwise no redundant
index is added.

## Frontend data flow

Add a focused `chat-history.ts` state reducer and use it from ChatView. The state
contains:

- ordered, deduplicated loaded messages;
- the cursor for the next older page;
- whether initial or older loading is active;
- a monotonically increasing session/request generation;
- Virtuoso's positive `firstItemIndex`.

`firstItemIndex` begins at the fixed `VIRTUAL_INDEX_ORIGIN = 1_000_000_000`.
It equals the origin minus the cumulative number of unique render items
prepended during this mounted session. Every prepend computes the old and new
`groupConsecutiveTools()` output and subtracts the actual render-item delta,
which accounts for tool groups merging across a page boundary. A prepend that
would make the index smaller than 1 is rejected with a visible recoverable
error; it never silently clamps because clamping would move the viewport. This
one-billion-item guard keeps all Virtuoso arithmetic within safe integers.
Virtuoso's imperative numeric `scrollToIndex` API uses the local data index,
so targets remain `localRenderIndex`; `firstItemIndex` is only supplied as the
prepend offset prop.

The reducer supports:

- replacing an empty session with its initial latest page;
- merging a refreshed latest page without dropping older loaded messages;
- prepending an older page exactly once even if requests overlap or repeat;
- appending a live message by ID;
- replacing a live-updated message in place;
- applying stream chunks only to an existing message;
- ignoring stale responses from a prior session generation;
- recording a monotonically increasing live revision for each WebSocket-mutated
  message;
- decrementing `firstItemIndex` by the actual number of newly introduced render
  items, including a tool-group merge at the page boundary.

ChatView continues to use SWR for the newest-page cache and reconnect
revalidation. It switches to a page-specific cache key and `api.listMessagePage`.
Older pages load imperatively from `nextCursor`; only one older request may be in
flight per session. A reconnect or Refresh fetches and merges the newest page,
preserving the user's loaded older window and current scroll position.

Every page request records the reducer's current live revision when it starts.
When its response arrives, a matching existing message whose per-message live
revision is newer than that request revision wins over the fetched snapshot;
otherwise the fetched row is authoritative. Therefore a stream chunk or
`message_updated` event that arrives during the request cannot be overwritten by
its older response. Inserts are always deduplicated by ID.

Virtuoso receives `firstItemIndex` and `startReached`. When older items are
prepended, decreasing `firstItemIndex` by the render-item delta preserves the
visible anchor. All numeric `scrollToIndex` calls use absolute indices derived
from `firstItemIndex`; the existing string `LAST` jump remains unchanged.

The initial latest page still lands at the bottom. While the user is above the
bottom, live messages increase the unseen counter without changing the viewport.
At the bottom, existing `followOutput` behavior remains active.

## Search navigation

Global search results must reference source messages; the search query and FTS
indexing paths continue to exclude `source_message_id IS NOT NULL`. Global
search may target a message older than the loaded window. When
`focusMessageId` is absent from loaded messages, ChatView automatically requests
older pages using the current cursor until it finds the target, exhausts
history, the session changes, or a request fails. These explicit navigation
loads use the maximum 500-message page size to avoid dozens of serial requests.
The loaded range remains contiguous from the target through the newest message,
so ordinary scrolling and Jump to latest remain truthful.

Top-scroll and focus navigation share one older-page request controller and one
cursor; they never fetch the same cursor concurrently. A successful page is
available to both consumers. Focus loading is an explicit state machine:
`idle → loading → found | exhausted | failed`. On failure it retains the target,
cursor, and focus marker, records `failed`, and stops automatic requests. The
existing Refresh control or a new `pinloom:goto-session` event for the same
target clears `failed` and retries; incidental renders, SWR revalidation, and
`startReached` cannot loop it. Exhaustion clears the marker and pending-focus
gate with a non-blocking “message is no longer available” error.

The existing focus marker is removed only after the target is actually loaded
and the Virtuoso jump has been scheduled. If the target no longer exists, the
load exhausts safely rather than looping.

## Compatibility and error handling

- `api.listMessages()` and the existing endpoint stay available for terminal
  side panels.
- Page responses are scoped to the requested session; cursors cannot escape the
  session because every query includes `session_id = ?`.
- Failed older-page requests retain current messages and cursor so Retry,
  reconnect, or a later scroll can continue.
- Stale initial, refresh, older-page, and focus-load responses are discarded
  after a session switch.
- WebSocket events are deduplicated by message ID, preventing a fetched latest
  page from duplicating an event received during the request.
- Streaming placeholders remain in the loaded latest window and are updated in
  place.

## Testing

Backend route tests cover the newest page, older cursor chain, equal timestamp
ordering, limit validation/clamping policy, malformed cursor rejection,
source-message exclusion, no duplicates or gaps, and empty history.

Frontend pure reducer tests cover initial load, prepend anchor arithmetic,
boundary tool-group merging, refresh merge, WebSocket deduplication, streaming
updates, stale generations, failure retry, and focus-target paging.

A browser regression creates more than one page of SDK messages and verifies:

- the session initially displays the latest page and is at the bottom;
- reaching the top loads older messages while keeping the visible anchor;
- a live message received while scrolled up does not jump the viewport;
- Jump to latest lands at the new message;
- switching away and back uses the cached newest page without showing the prior
  session;
- navigating to an older search result loads and focuses it.

Focused frontend/backend tests, full suites, repository typecheck, production
build, isolated Playwright smoke, and `git diff --check` must pass before
deployment.

## Non-goals

- Paginating terminal side-panel history in this change.
- Deleting or compacting stored messages.
- Changing Claude's native compaction or prompt behavior.
- Adding a new list library or state-management dependency.
- Reworking message grouping, markdown rendering, or search ranking.
