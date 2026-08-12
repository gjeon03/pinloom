# Codex Long-Session Rollover Design

## Goal

Keep long Codex terminal sessions responsive without deleting their Pinloom history or relying on repeated in-thread compaction.

Success means:

- PTY output remains responsive even when the active Codex rollout is hundreds of megabytes.
- Pinloom shows the current Codex context pressure using data emitted by the Codex rollout.
- A user can continue a heavy Codex session in a fresh thread with a concise checkpoint.
- The original session, messages, and rollout files remain intact.
- Claude sessions and Codex SDK sessions keep their existing behavior.

## Evidence and constraints

One observed Codex terminal session had a 323 MiB active rollout and 310 rollout files occupying 2.9 GiB. The active rollout contained 34 successful compactions. Early compaction reduced the model-visible input from roughly 232k to 24k tokens, while the thirty-fourth reduced it from roughly 243k to 95k. Compaction therefore works, but its retained baseline grows over a very long thread.

The old Pinloom capture loop also read and parsed the complete active rollout every 500 ms. That local hot path is independent of model compaction and can block the backend event loop. The in-progress incremental rollout reader and amortized PTY scrollback buffer address that immediate runtime cost.

Pinloom owns the durable conversation history in SQLite. Codex rollout files are still required for native `codex resume`, so this feature must not remove or rewrite them.

## Considered approaches

### 1. Tune or invoke Codex compaction

Lower `model_auto_compact_token_limit` or invoke compact more often.

This reduces peak context pressure but does not reset the retained summary baseline, shrink append-only rollout files, or prevent repeated large compaction records. More frequent compaction can also accelerate summary accumulation. This is not the primary solution.

### 2. Replace the Codex thread inside the same Pinloom session

Clear the resume token and Codex home while keeping the existing Pinloom tab.

This looks seamless but hides a real context boundary, complicates transcript cursors, makes prior/next navigation ambiguous, and risks mixing messages from two agent threads under one capture lifecycle. It is rejected for the first implementation.

### 3. Create a linked Pinloom session with a fresh Codex thread

Preserve the source session and create a new session in the same project. Inherit the agent, terminal transport, model, reasoning effort, and plan. Link the new session through `source_session_id`, set both native resume identifiers to `NULL`, and seed the new session with a bounded checkpoint.

This makes the context boundary explicit, keeps rollback trivial, and reuses Pinloom's existing handoff/tab-opening patterns. This is the selected approach.

## Architecture

### Incremental rollout capture

Finish the existing performance work:

- Keep a byte offset and parsed-line cursor for the active rollout.
- Read only complete JSONL lines appended since the previous poll.
- Persist the cursor as a backward-compatible opaque JSON value.
- Use a bounded chunk-based scrollback instead of concatenating and slicing a 200 KiB string for every PTY event.
- Preserve existing turn completion, stalled-turn fallback, dispatch waiting, and legacy integer cursor behavior.

Large top-level `compacted` records are not captured as chat rows and do not increment telemetry counters. The incremental reader may represent these known noise records with a lightweight sentinel when it can do so without changing parsed-line cursor semantics.

### Context health state

Add a `codex_context_state` table keyed by Pinloom session ID. It stores only derived telemetry:

- current input tokens;
- cached input tokens;
- model context window;
- total observed compactions;
- input tokens immediately after the latest compaction;
- latest rollout byte size;
- whether the next valid token sample must become the post-compaction baseline
  (internal recovery state, not exposed to the UI);
- update timestamp.

The rollout capture service updates this state from `event_msg:token_count` and `event_msg:context_compacted`. Codex writes one top-level `compacted` record and one `event_msg:context_compacted` for the same operation; only `context_compacted` is the canonical signal and increments the observed count, preventing double-counting. After that signal, the next positive, valid `token_count.last_token_usage.input_tokens` becomes the post-compaction baseline. Zero or malformed token events do not clear the pending baseline. State is persisted so reopening Pinloom does not require rescanning old rollout files.

Existing sessions are not backfilled. Scanning a historical multi-hundred-megabyte rollout to reconstruct counters would recreate the performance problem this work removes. A migrated session therefore reports telemetry as unavailable until Codex emits its next `token_count`; its compaction count means compactions observed after telemetry tracking began, and its post-compaction baseline stays unavailable until the next observed compaction. The UI labels these values as tracked observations rather than lifetime totals.

Expose `GET /api/sessions/:sessionId/codex-context` for initial state. Emit a session WebSocket event after meaningful changes so the UI does not poll large files or repeatedly query SQLite.

Derived severity is calculated from data rather than persisted:

- normal: input below 75% of the context window;
- elevated: 75% to below 90%;
- critical: 90% or above;
- unavailable: no valid token event has been captured yet.

The post-compaction baseline is shown as supporting information, not used for automatic rollover in the first version.

### Checkpoint generation

When the user requests rollover, Pinloom asks the current Codex terminal to produce one final bounded handover reply. The prompt requests no more than 12,000 Unicode code units of concise Markdown with:

- current objective and progress;
- decisions and constraints;
- changed files and relevant commands;
- open work and next action;
- failures, gotchas, and verification state.

The returned text is trimmed and must be non-empty. A response at or below 16,000 Unicode code units is preserved exactly. A longer response is bounded deterministically to its first 12,000 and last 4,000 code units with an explicit omission marker between them, preserving both the initial state summary and the final next steps. Only this bounded form is copied to the destination; the source transcript retains the complete Codex response. If the terminal is busy, team-owned, missing, times out, or returns an empty checkpoint, rollover fails without creating a destination session. The user can retry after the source session is idle.

The checkpoint request is intentionally visible in the source transcript. This gives the user an auditable final state and avoids a second hidden model invocation with different context.

### Session creation

Add `POST /api/sessions/:sessionId/rollover`.

Preconditions:

- source exists;
- source agent is Codex;
- source transport is terminal;
- source is not a bot, team orchestrator, or team worker;
- no turn or shell command is currently running;
- no other rollover for the source is in flight.

After a valid checkpoint is returned, one SQLite transaction:

1. creates a new session after the existing project sessions;
2. inherits project, plan, agent, model, reasoning effort, and transport;
3. records `source_session_id` and leaves agent resume IDs null;
4. copies existing pins using the current handoff semantics;
5. persists the checkpoint as a pinned assistant message titled `Rollover checkpoint`.

The source session identity, resume identifiers, pins, and Codex home remain unchanged. Its transcript and `updated_at` deliberately advance because the visible checkpoint request and complete Codex response are its final turn. The new Codex home is created only when its terminal first opens.

### User interface

For Codex terminal sessions, the terminal side panel shows a compact context row:

- token percentage and absolute values;
- compaction count;
- latest post-compaction baseline when available;
- `Continue fresh` action.

The row becomes visually prominent at elevated and critical thresholds, but never triggers a rollover automatically.

Clicking `Continue fresh` explains that a final checkpoint turn will run, disables duplicate requests, and then opens the returned session as a new dock tab through the existing `onHandoff` path. Errors remain attached to the source panel and do not create a destination session.

Strings are added in English, Korean, and Chinese through the existing i18n catalog.

## Data flow

1. Codex appends `token_count`, normal turn, and compaction events to its active rollout.
2. The incremental capture reads the appended bytes and updates captured messages plus context telemetry.
3. The backend persists telemetry and broadcasts a session event.
4. The side panel renders the latest health state.
5. The user requests rollover when the thread is heavy.
6. The backend obtains a final checkpoint from the source Codex terminal.
7. A transaction creates a linked, fresh destination session seeded with the checkpoint and pins.
8. The frontend opens the destination tab. Its first attach launches Codex without `resume`.

## Error handling and safety

- No rollout or message deletion is part of this feature.
- A failed checkpoint produces no destination session.
- Destination creation is transactional, including copied pins and checkpoint persistence.
- Duplicate concurrent rollover requests return a conflict.
- Terminal locks prevent human input and rollover checkpoint input from interleaving.
- Team sessions are excluded until membership migration semantics are designed.
- Context telemetry failure never blocks transcript capture or the terminal.
- Legacy cursor migration and missing/truncated rollouts retain their current recovery behavior.

## Testing

Backend tests cover:

- incremental reads, partial lines, malformed lines, truncation, and legacy cursor migration;
- scrollback equivalence to the old bounded buffer;
- context telemetry extraction and persistence;
- WebSocket event shape;
- rollover preconditions and duplicate-request protection;
- no destination session when checkpoint generation fails or returns empty output;
- transaction rollback when destination session, copied pins, or checkpoint persistence fails after generation;
- inherited session fields, copied pins, checkpoint pin, and null resume identifiers;
- fresh Codex launch after rollover.

Frontend tests cover pure context severity/formatting logic. Existing unit suites, typecheck, build, and the local Playwright smoke test run before release.

## Deployment

Deployment is explicitly authorized after implementation and verification. The release step runs only after:

- typecheck passes;
- backend and frontend tests pass;
- production build passes;
- local Playwright smoke passes;
- the final diff and working tree are reviewed for secrets and unintended files.

The existing desktop staging, packaging, and deployment scripts remain the release mechanism. Deployment must not delete the user's current rollout files or SQLite data.
