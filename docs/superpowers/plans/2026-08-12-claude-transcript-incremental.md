# Claude Transcript Incremental Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace active Claude whole-transcript parsing with durable complete-line byte cursors shared by terminal capture and the PTY-backed Claude SDK adapter.

**Architecture:** Introduce a pure stateful Claude JSONL tail reader, then persist terminal capture identity/offset/type in a new SQLite table while retaining the legacy UUID column. Wire the PTY-backed SDK adapter and transport conversion to checkpoints from that reader so steady-state work is proportional to appended bytes.

**Tech Stack:** TypeScript strict mode, Node.js 22 filesystem APIs, better-sqlite3, Vitest 4, pnpm 10.

## Global Constraints

- Preserve all existing uncommitted user changes; never revert, delete, or overwrite unrelated work.
- Do not create commits; the user did not explicitly request commits.
- Use named exports and 2-space indentation; prefer `const` and never use `var`.
- Do not add or upgrade dependencies.
- Source code comments must not contain issue or ticket numbers.
- Do not rewrite, truncate, or delete Claude transcript files or Pinloom messages.
- Claude native compaction, launch arguments, normalized events, resume identifiers, pins, and visible UI remain unchanged.
- Active Claude terminal and PTY-backed SDK turn paths must not call whole-file `readLines()`.
- Open transcript files before using `fstatSync()` for identity/size; all reads for that call use the same descriptor.
- Durable offsets advance only past complete newlines and only after all message persistence for that delta succeeds.
- Legacy null-`transcript_uuid` history with missing transcript UUID seeds at complete EOF and must not replay ambiguous history.
- Replacement/truncation persists a zero state for the new identity before accepting new-generation offsets.
- Tests must prove idle/repeat reads do not read historical transcript bytes.
- Deployment requires focused tests, full backend/frontend suites, repository typecheck, production build, isolated browser smoke, final independent review, and `git diff --check`.

---

### Task 1: Stateful Claude JSONL Tail Reader

**Files:**
- Create: `packages/backend/src/services/claude-pty/transcript-tail.ts`
- Create: `packages/backend/src/services/claude-pty/transcript-tail.test.ts`
- Modify: `packages/backend/src/services/claude-pty/transcript.ts`
- Modify: `packages/backend/src/services/claude-pty/transcript.test.ts`

**Interfaces:**
- Produces: `createClaudeTranscriptTailState(offset?: number, dependencies?: { readChunk?: typeof readSync; transcriptIdentity?: string | null }): ClaudeTranscriptTailState`.
- Produces: `readClaudeTranscriptDelta(file: string, state: ClaudeTranscriptTailState): ClaudeTranscriptDelta` with `lines`, `lineEnds`, `completeOffset`, `fileSizeBytes`, `transcriptIdentity`, `bytesRead`, `pendingBytes`, and `reset`.
- Produces: `readCheckpoint(file: string): ClaudeTranscriptCheckpoint | null` exactly as defined in the design.

- [ ] **Step 1: Add failing reader tests**

  Cover one-line append, unchanged-file `bytesRead === 0`, multiple appends on one state, split UTF-8 across injected reads, partial final JSON retained once, malformed complete JSON consumed, read interruption/resume, inode replacement, same-inode truncation, and a file larger than 1 MiB whose second poll reads only appended bytes.

- [ ] **Step 2: Run RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/services/claude-pty/transcript-tail.test.ts src/services/claude-pty/transcript.test.ts
  ```

  Expected: failure because the new reader exports and checkpoint result shape do not exist.

- [ ] **Step 3: Implement the reader**

  Use `openSync → fstatSync → positional readSync → closeSync`, a fixed `1 << 20` buffer, chunked partial-line storage, and `parseJsonlLine()` after newline completion. A reset clears partial chunks and positions before returning `reset: true` at offset zero. Missing/read failures preserve the prior complete offset and report no data.

- [ ] **Step 4: Implement bounded reverse checkpoint reading**

  Read complete newline-delimited records from the end in fixed chunks. Ignore an incomplete trailing fragment. Return the last UUID, complete EOF offset, identity, and latest meaningful filtered non-sidechain/non-synthetic user or assistant type. Preserve `readLines()` for non-active compatibility callers.

- [ ] **Step 5: Run GREEN and quality checks**

  Run the focused command from Step 2, backend typecheck, and `git diff --check` for the four owned files.

### Task 2: Durable Terminal Capture Cursor

**Files:**
- Modify: `packages/backend/src/db/migrations.ts`
- Modify: `packages/backend/src/db/migrations.test.ts`
- Modify: `packages/backend/src/services/claude-pty/transcript-capture.ts`
- Modify: `packages/backend/src/services/claude-pty/transcript-capture.test.ts`

**Interfaces:**
- Consumes: Task 1's stateful reader and checkpoint.
- Produces: migration 42 `claude_transcript_state` with the exact design schema.
- Preserves: `sessions.last_captured_transcript_uuid` as a plain UUID or null.

- [ ] **Step 1: Add failing migration and capture tests**

  Cover table schema/FK cascade; legacy UUID migration; missing UUID with all transcript-backed rows replaying safely; missing UUID with any null-UUID source history seeding at complete EOF; unreadable migration pending; repeat Stop reading only appended bytes; complete noise/malformed offset advancement; restart between user and assistant; state transaction failure replay; inode replacement and truncation zero-state crash recovery.

- [ ] **Step 2: Run RED**

  Run:

  ```bash
  pnpm --filter @pinloom/backend test -- src/db/migrations.test.ts src/services/claude-pty/transcript-capture.test.ts
  ```

  Expected: failures for the missing migration/state and historical rereads.

- [ ] **Step 3: Add migration 42**

  Add the exact table from the approved design. Assert all columns and session deletion cascade in migrations tests.

- [ ] **Step 4: Replace capture's `seen` whole-history model**

  Store one reader tail and durable last conversation type in `CaptureState`. Initialize from the state row or the legacy migration policy. Filter only returned delta lines with the existing turn eligibility rules. Reuse one tail through fast flush polls and rescans; settlement derives from durable/latest meaningful type.

- [ ] **Step 5: Make persistence and cursor commit crash-consistent**

  Persist eligible rows and update both legacy UUID and `claude_transcript_state` in one better-sqlite3 transaction. Advance offsets for complete non-message lines. On errors retain/recreate state from the last durable offset so retries replay safely. Commit zero identity/offset state before consuming a replacement generation.

- [ ] **Step 6: Run GREEN**

  Run the focused command, the complete backend suite once, backend typecheck, and scoped `git diff --check`.

### Task 3: PTY-backed SDK and Transport Conversion Wiring

**Files:**
- Modify: `packages/backend/src/services/claude-pty/node-session.ts`
- Modify: `packages/backend/src/services/claude-pty/node-session.test.ts`
- Modify: `packages/backend/src/services/transport-convert.ts`
- Test: existing transport conversion test file if present; otherwise create `packages/backend/src/services/transport-convert.test.ts`.

**Interfaces:**
- Consumes: Task 1 reader/checkpoint and Task 2 durable table.
- Produces: one in-memory reader state per PTY-backed SDK process; conversion seeds/deletes terminal cursor state transactionally.

- [ ] **Step 1: Add failing SDK and conversion tests**

  Extend the deterministic mock Claude test to create a large preexisting resume transcript, run two turns, and assert historical bytes are not reread after initialization while results match existing normalized events. Test partial assistant flush polling. Test SDK→terminal seeds UUID, identity, offset, type in the conversion transaction and terminal→SDK removes only terminal reader state.

- [ ] **Step 2: Run RED**

  Run focused node-session and transport conversion tests. Expected: reader-spy assertions fail because current code calls `readLines()` and conversion lacks the state row.

- [ ] **Step 3: Wire the SDK adapter**

  Initialize a tail at the prelaunch checkpoint for resumed seeded turns and at zero after fresh discovery. Accumulate only new delta lines per turn. Later turns reuse the same state; do not collect historical UUIDs. Preserve Stop-hook ordering, trust handling, images, aborts, and event normalization.

- [ ] **Step 4: Wire transport conversion**

  For SDK→terminal, obtain the checkpoint and update transport, legacy cursor, and state row atomically. For terminal→SDK, stop live terminal capture first and delete only `claude_transcript_state`; preserve resume identifiers and transcript bytes.

- [ ] **Step 5: Verify task and whole feature**

  Run focused tests, full backend suite, repository `pnpm typecheck`, production `pnpm build`, and `git diff --check`.
