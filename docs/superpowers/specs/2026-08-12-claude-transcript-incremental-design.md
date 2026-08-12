# Claude Transcript Incremental Processing Design

## Goal

Keep Claude terminal and Claude SDK sessions responsive as their native JSONL
transcripts grow, without changing Claude's UI, native compaction, resume
behavior, or Pinloom history.

Success means:

- active turns read only bytes appended since the previous read;
- polling an unchanged transcript performs metadata I/O only and does not parse
  historical JSONL;
- a backend restart resumes from a durable complete-line byte boundary;
- legacy UUID-only sessions migrate safely without losing or duplicating
  messages;
- file replacement, truncation, partial JSON, malformed JSON, and UTF-8 split
  boundaries cannot advance the durable cursor past unprocessed content;
- Claude terminal capture and the PTY-backed Claude SDK adapter preserve their
  existing turn selection and completion semantics;
- no Claude transcript file is rewritten, truncated, or deleted.

## Evidence

The current `readLines()` implementation calls `readFileSync(file, 'utf8')`
and parses the complete JSONL file. Terminal capture calls it during Stop-hook
processing, catch-up, fast flush polling, and late assistant rescans. The
PTY-backed SDK adapter calls it while seeding resumed sessions, polling for a
settled reply, and snapshotting UUIDs before later turns.

On a local 197,963,020-byte Claude transcript containing 81,212 lines, one
`readLines()` call measured about 757 ms and raised process RSS to roughly
1.16 GiB. One Stop or SDK turn can invoke that path more than once. The cost is
therefore proportional to total session history instead of the newly appended
turn.

## Considered approaches

### 1. Cache the most recent whole-file parse

Cache parsed lines using path, size, and modification time.

This reduces identical rereads but still allocates and parses the complete file
after every append. It also retains a very large parsed object graph. Rejected.

### 2. Scan from the beginning until the persisted UUID

Stream the file from byte zero on each Stop and discard lines until the UUID
cursor is found.

This bounds memory but still makes every turn O(total transcript bytes).
Rejected as the steady-state design; it is acceptable only as a one-time legacy
migration path.

### 3. Durable file identity plus complete-line byte offset

Maintain a stateful chunk reader per active Claude process and persist the open
file identity, last fully processed newline offset, last processed UUID, and
latest meaningful conversation type. Read only appended chunks and retain an
unfinished tail until its newline arrives.

This makes steady-state work O(appended bytes), supports safe restart recovery,
and matches the already-proven Codex rollout-reader architecture. Selected.

## Architecture

### Incremental transcript reader

Add a Claude-specific reader module with no database dependencies. It owns:

- a fixed 1 MiB read buffer;
- `readPosition`, including an unfinished line already read into memory;
- `completeOffset`, immediately after the last consumed newline;
- the open file identity encoded as `device:inode`;
- chunked storage for the current unfinished line;
- injected `readSync` support for deterministic interruption tests.

Each read returns parsed complete `JsonlLine` values, the byte end of each
returned line, physical file size, file identity, bytes read, pending bytes, and
a replacement/truncation flag. Blank and malformed complete lines advance the
physical complete offset but do not produce values. An incomplete final line
does not advance `completeOffset`. UTF-8 is decoded only after a complete line
has been assembled, so multi-byte code points split across physical reads remain
valid.

The reader calls `openSync()` first, obtains identity and size through
`fstatSync()` on that exact descriptor, and performs all bounded positional
reads from that descriptor. It never combines `stat(path)` metadata with bytes
from a separately opened file. An unchanged file returns without allocating a
transcript-sized buffer. A changed inode or a file shorter than the state drops
all unfinished-line chunks, resets the reader to byte zero, and reports the
reset to its caller.

The existing whole-file `readLines()` helper remains available for compatibility
and narrow offline use, but no active Claude terminal or SDK turn path may call
it. `readCheckpoint()` becomes a bounded reverse chunk scan with this exact
contract:

```ts
export interface ClaudeTranscriptCheckpoint {
  uuid: string | null;
  completeOffset: number;
  transcriptIdentity: string;
  lastConversationType: 'user' | 'assistant' | null;
}

export function readCheckpoint(file: string): ClaudeTranscriptCheckpoint | null;
```

It ignores an incomplete trailing JSON fragment, returns the physical offset
immediately after the last complete newline, and finds the last valid complete
line containing a UUID plus the last meaningful filtered conversation type. An
unreadable file returns `null`; a readable empty file returns a checkpoint with
offset zero and nullable semantic fields.

### Durable terminal-capture state

Migration 42 adds `claude_transcript_state`:

```sql
CREATE TABLE claude_transcript_state (
  session_id                  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  transcript_identity         TEXT NOT NULL,
  complete_offset             INTEGER NOT NULL,
  last_transcript_uuid        TEXT,
  last_conversation_type      TEXT CHECK(last_conversation_type IN ('user', 'assistant') OR last_conversation_type IS NULL),
  updated_at                  TEXT NOT NULL
);
```

`sessions.last_captured_transcript_uuid` remains populated for backward
compatibility and deduplication. It is not overloaded with JSON.

When no state row exists:

- a fresh session begins at byte zero;
- an existing session with a UUID cursor performs one bounded-memory forward
  scan to find that UUID's newline, derives the latest meaningful user/assistant
  type up to that boundary, and immediately persists identity and offset;
- if the UUID cannot be found and every existing source message for the session
  has a non-null transcript UUID, capture starts at byte zero and relies on the
  unique transcript UUID index to discard already-folded rows;
- if the UUID cannot be found and any existing source message has a null
  transcript UUID, capture seeds at the transcript's current last complete
  newline and logs a warning instead of replaying ambiguous history. This
  preserves existing SDK/pre-migration rows without duplicating them. Future
  appends are captured normally. The exceptional ambiguous gap is not guessed;
- if no cursor exists but the session already contains source messages, apply
  the same null-transcript-UUID safety decision instead of treating it as fresh;
- an unreadable file leaves migration pending and does not guess an offset.

The capture state keeps only newly parsed lines. It filters them with the same
sidechain, noise, and synthetic-message rules as `selectTurnLines()`, persists
the same message rows, and records the latest meaningful conversation type.
Complete blank, noise, synthetic, and malformed-only deltas still advance the
durable physical offset and preserve the last meaningful conversation type.
After all message writes for a delta succeed, one database transaction updates
the legacy UUID and the durable Claude state row. If a write or state commit
fails, the durable offset does not advance; a retry replays the range and the
unique index prevents duplicate messages or broadcasts.

Fast flush polling and late assistant rescans reuse the same tail object. They
never reread consumed history. `last_conversation_type='user'` is durable, so a
restart between an early Stop hook and the assistant flush continues the rescan
instead of incorrectly treating the turn as settled.

On replacement or truncation, capture first persists a zero-offset state for
the new identity, then processes from byte zero. A crash before the reset commit
redetects the old identity mismatch; a crash after it safely resumes the new
generation.

### PTY-backed SDK adapter

The SDK adapter does not need SQLite cursor state because one adapter instance
owns one live Claude process. It uses the same reader with an in-memory state:

- before launching a resumed seeded turn, initialize at the current last
  complete newline rather than collecting every historical UUID;
- after a fresh transcript is discovered, initialize at byte zero;
- after each Stop, poll the reader and accumulate only lines belonging to the
  current turn until assistant content is present;
- later turns reuse the same state rather than snapshotting all historical
  UUIDs.

Abort, timeout, trust-dialog, image, session discovery, and normalized-event
contracts stay unchanged. A replacement or truncation resets to zero and uses
the existing turn filters; because a live Claude session is expected to append
to one file, replacement is an exceptional recovery path and is logged.

### Transport conversion

Claude SDK-to-terminal conversion uses the reverse checkpoint scan to obtain the
last UUID and the last complete byte offset. It seeds both the legacy session
cursor and `claude_transcript_state` in the same SQLite transaction that changes
transport. Terminal-to-SDK conversion clears terminal-only durable reader state
after the live capture has been stopped; it does not change the Claude resume
identifier or transcript.

## Error handling and recovery

- Missing or unreadable files produce no data and never advance a durable
  offset.
- Read interruptions preserve completed lines and retain the unfinished suffix
  for the next call.
- Malformed complete JSON is skipped consistently with the current parser while
  its newline is consumed, preventing a permanent retry loop.
- Message persistence errors stop cursor advancement.
- Replacement and truncation reset before any new-generation offset is trusted.
- Replayed lines are idempotent through the existing unique transcript UUID
  constraint; rows without usable UUIDs are never persisted as conversation
  messages by the existing selection rules.

## Testing

Reader unit tests cover incremental append, idle reads, 1 MiB boundaries,
split UTF-8, partial lines, malformed complete lines, read interruption,
replacement, truncation, reverse checkpoint scanning, and bytes-read bounds.

Terminal capture tests cover legacy migration, missing legacy UUID fallback,
restart deduplication, late assistant flush across restart, state-write failure,
replacement reset, and verification that repeat polls read only appended bytes.
The missing-cursor cases include both transcript-UUID-backed history, which may
replay safely, and SDK/pre-migration null-UUID history, which must seed at the
current complete EOF without duplicating rows.

SDK adapter tests use the existing deterministic mock Claude binary and assert
that resumed and subsequent turns no longer require whole-history parsing while
preserving normalized results.

Focused tests, the complete backend suite, repository typecheck, production
build, and `git diff --check` must pass before deployment.

## Non-goals

- Changing Claude Code's native compaction threshold or prompt.
- Rewriting or compacting Claude transcript files.
- Adding Claude context-pressure UI.
- Changing transcript message normalization or pin semantics.
- Optimizing unrelated offline export, backup, or search paths.
