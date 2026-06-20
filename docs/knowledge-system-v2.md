# pinloom Knowledge System v2 — design & roadmap

Status: **design / roadmap** (no code yet). Reference-driven by
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Revised after a 4-lens consensus review (architecture / pinloom-fit /
SQLite-FTS5 / UX) — see §9. Verdict: **sound direction, revise-before-build;
Phase 1 is feasible and empirically de-risked against the project's own
better-sqlite3 (SQLite 3.53.0).**

## 1. Why this doc

The Wiki is pinloom's durable knowledge layer (`~/.pinloom/wiki/`, injected
every turn — see `runner.ts:buildWikiContext`). It already does the
*structured-notes* job well: per-project pages with `applies_to` scoping,
session→wiki **sync**, codebase **analyze**, `index.md`/`_schema.md`,
export/import. What it lacks is everything that keeps that knowledge **fresh,
findable, and lean over time**.

hermes-agent is the reference people point at for "the agent that organizes
its own knowledge." Stripped of hype, its value is four systems, not a wiki:
self-authored **skills**, **bounded curated memory**, **SQLite FTS5 session
search**, and **user modeling**. pinloom already beats hermes on the
hand-curated wiki (hermes has no wiki editor). The borrowable gaps are
**bounded curation**, **FTS session search**, and a **user-profile layer**.

## 2. Scope

In scope: **③ Session FTS5 search**, **① Wiki gardener** (dedup / merge /
prune-to-archive / fix links / tighten / re-scope), **② Automatic sync
suggestion**, **④ User-profile layer**.

**Deferred (explicit user decision): ⑤ skill auto-generation/management.** Not
designed here. The curation primitive (§4 B) is kept generic enough that skill
extraction can later be one more *proposal type* writing the **standard**
`~/.claude/skills/<name>/SKILL.md` format (no proprietary format). Keep
**wiki = knowledge (context)** distinct from **skill = procedure (invokable)**.

## 3. Design rules this must honor

- **No auto-deletion.** Wiki pages / messages / sessions only disappear by
  explicit user action. → The gardener **stages** changes and **archives**
  superseded content; it never silently deletes, and never gets live `Write`
  access to `~/.pinloom/wiki/` (unlike today's `wiki-sync`, which runs with
  `bypassPermissions`).
- **User-controlled, not opaque.** Every automated change is a **reviewable
  proposal**, accepted per-item.
- **Local-only.** FTS5 lives in the existing `data/pinloom.sqlite`; no new
  service, no cloud. *(Caveat for ④: "local-only" must not be used to imply
  profile text never leaves the machine — it is sent to the model every
  turn.)*
- **Token discipline.** The regular wiki is *pointer*-injected — the agent
  reads `index.md` + matched pages on demand each turn, so a leaner, deduped
  wiki is cheaper every turn (ties to the billing/PTY work). **④ USER.md is
  the one always-inlined exception** → it must be bounded and cache-prefixed
  (§5 ④), or it contradicts the pointer model it relies on.

## 4. Architecture — two shared backbones

### Backbone A — FTS5 message index (the foundation)

**Locked schema** (external-content FTS5; `messages` is *not* `WITHOUT ROWID`,
so the implicit integer `rowid` backs the table despite the TEXT `id` PK):

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram remove_diacritics 1'
);
```

Rationale: external-content avoids doubling storage and still serves
`snippet()`/`highlight()` (contentless cannot). **trigram** is the only viable
tokenizer for mixed Korean+English — ICU is not compiled into the bundled
build, and `unicode61` cannot segment Korean (returns 0 rows for Korean
substring queries). `porter` stems English only. The cost: trigram matches
only at **≥3 characters** — handled in the query layer (§5 ③), not the schema.

**Trigger contract (must respect streaming).** `messages` are **not
write-once**: `persistMessage` creates an **empty-content** row first and
`runner.ts` **UPDATEs `messages.content` on every `closeStream` flush**. So
triggers must (a) use the FTS5 `'delete'` command-insert form on remove/update
(a plain `DELETE` corrupts an external-content index), (b) scope the update
trigger to `OF content` (so `pinned`/`pinned_at` writes don't re-index), and
(c) **skip empty/partial content** so chunk-flushes don't thrash or bloat the
index. Index `content` only — **not `tool_use`** (noise + privacy surface) —
and restrict to `role IN ('user','assistant')`.

```sql
CREATE TRIGGER messages_ai AFTER INSERT ON messages
  WHEN new.content <> '' AND new.role IN ('user','assistant')
BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content)
    SELECT new.rowid, new.content
    WHERE new.content <> '' AND new.role IN ('user','assistant');
END;
```

*(The delete-insert is unconditional and harmless when no prior row exists;
the re-insert is guarded so empty/partial flushes index nothing.)*

**Backfill** (external-content tables start empty; triggers only catch future
writes) — inside the migration transaction:

```sql
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
INSERT INTO messages_fts(messages_fts) VALUES ('optimize');
```

**Cascade-delete is verified, not assumed.** With `foreign_keys=ON` (set in
`connection.ts` on every writing connection), deleting a session cascades to
its `messages` **and** fires the per-row `AFTER DELETE` trigger, leaving the
index empty and passing FTS5 `integrity-check`. Requirements: a **regression
test** asserting `messages_fts` is empty after a session delete; optionally a
one-shot startup reconciliation dropping FTS rows with no backing message.

Powers **③** directly; reused **read-only** by **①** (find evidence /
contradictions for a wiki claim).

### Backbone B — Curation engine (stage → review → apply/archive)

The safety mechanisms here are the hard part; today they are *fictional*
(marker preservation is prompt-only, "archive not delete" has no
implementation). So the engine is **thin and code-enforced**, built before any
LLM touches it.

- **Staging store** — a small table of proposals: `id, status, created_at,
  source, type, payload`. Each proposal **type** carries a small typed payload
  and its own `apply()`; there is no universal diff/god-schema.
- **Proposal generation is NOT free-form LLM diffs.** The SDK agent is
  reliable at *editing files*, not at emitting trustworthy machine-parseable
  diffs. Instead the agent either (a) writes proposed page versions into a
  **staging dir** and pinloom computes the diff deterministically, or (b)
  emits **structured typed proposals via tool calls** that pinloom records as
  rows.
- **Deterministic marker-respecting applier** (replaces the honor-system
  prompt). On accept it splices new content **strictly between existing
  `<!-- pinloom:auto-section -->` markers**, **rejects/flags any proposal that
  would change bytes outside the markers or mutate frontmatter**, and for
  marker-less pages wraps existing content as user-owned + creates an empty
  auto-section. The agent never gets live `Write` to live pages.
- **Per-page archive + restore primitive** (net-new — `wiki-archive.ts` today
  only does whole-tree zip export/import): `~/.pinloom/wiki/_archive/` with an
  append-only manifest `{archivedAt, originalRelPath, reason, proposalId,
  supersededBy}`, **one-click restore** in the UI, surviving export/import. A
  merge proposal's diff shows "these pages move to archive."
- **Concurrency**: all gardener/sync applies route through the existing global
  **`syncChain`** serialization (`wiki-sync.ts`) so they can't race a normal
  sync or a hand-edit on `index.md`/`pages/`. A proposal generated against a
  **stale page version is rejected at accept-time**, not silently overwriting
  an intervening edit.

Powers **①** and **②** (and, later, deferred **⑤**).

## 5. Feature designs

### ③ Session FTS search — Phase 1

- DB: migration **29** (Backbone A).
- API: `GET /api/search?q=...&projectId?=...` → ranked rows with
  session/project context + `snippet()`/`highlight()` excerpts. **Query
  safety**: tokenize the user query in JS — route each **≥3-char** token to
  FTS `MATCH` as a **double-quoted phrase** (AND'd together; never pass raw
  user text as a bareword MATCH → prevents FTS5 operator/syntax injection and
  500s), and route **1–2-char** tokens (common 2-syllable Korean: 배포, 인증,
  타입, 쿼리) to a **trigram-accelerated `LIKE '%token%'`** filter on
  `messages.content`. Document the 3-char threshold.
- UI: a search field (global + per-project via scope chips); results list with
  snippets. **v1 jumps to the SESSION only.** Scroll-to-message-id is
  **deferred** — it is new work (`gotoSessionTab` opens at the tail; ChatView
  scrolls by Virtuoso *array index* over a windowed list, not by message id),
  not free reuse.
- **Acceptance gate before locking migration 29**: a bake-off test over a real
  export including 2-char Korean terms must pass (migrations are forward-only;
  a later tokenizer change needs a fresh DROP+rebuild migration).

### ① Wiki gardener — Phase 2 (split 2a / 2b)

**Phase 2a — plumbing, fixture-driven, zero LLM**: the shared staging store +
review panel + deterministic marker-respecting applier + per-page
archive+restore primitive (Backbone B). This must exist and be proven first.

**Phase 2b — the gardener agent**: an SDK `query` agent behind a **manual
"Garden" button** (no background/scheduled gardening in v1), **wiki-only**,
confined to staging. It reads `index.md` + `pages/` and queries the FTS index
**read-only**. Operation tiers:

- **Auto-stage applyable proposals** (low risk): fix broken `related` links,
  tighten over-long summaries/pages, re-scope `applies_to`.
- **Flag-only** (high risk, no apply in Phase 2): dedup/**merge A+B→C**, any
  **archive**, and **contradiction detection** (LLM judgment against FTS
  evidence — flag, never auto-resolve). Merge/archive become accept-to-apply
  only after 2a's applier and archive-restore are proven.

### ② Automatic sync suggestion — Phase 3

After a session ends or accrues N substantive turns, pinloom **suggests**
"sync this session to the wiki?" (notification/badge). It **never auto-writes**.
On accept, the sync flow runs and emits a **staged proposal** (reusing
Backbone B) for review. All reads/writes route through `syncChain`; a proposal
against a stale page is rejected at accept-time.

### ④ User-profile layer — Phase 4

A dedicated `~/.pinloom/wiki/USER.md` capturing **preferences and working
style**, distinct from project *knowledge*. **Injection mechanism (decided)**:
inject verbatim but place it firmly in the **static cache-prefix half** of the
system prompt (it changes rarely → cache-served and cheap after turn one), with
a **hard char budget** (reuse the existing 4000-char Teams-instructions
ceiling) enforced at injection time with **truncate-with-notice**. A plain UI
line states the profile is **sent to the model every turn**. The gardener
treats an over-budget profile as a consolidation proposal. The user edits it
freely; agents only *propose* additions.

## 6. Sequencing — PR-by-PR

Lock the tokenizer/schema **before PR1** (migrations are forward-only; ids are
non-contiguous — 20/21 are intentionally absent, so **29 = max(id)+1**; do not
backfill the gap).

| PR | Content |
|----|---------|
| **PR1** | migration 29 (external-content trigram FTS5 + `'delete'`-command triggers + `'rebuild'` backfill) + read-only `/api/search` (JS tokenizer: MATCH ≥3-char, LIKE 1–2-char) + regression tests |
| **PR2** | Phase 1 search UI (global + per-project, snippets, **jump-to-session**) |
| **PR3** | Phase 2a: thin staging store + review panel + deterministic applier + archive/restore primitive (fixture-driven, no LLM) |
| **PR4** | Phase 2b: gardener SDK agent behind a manual Garden button (safe-op auto-stage + flag-only merge/archive) |
| **PR5** | ② sync-suggestion reusing the staging/review primitive (never auto-writes) |
| **PR6** | ④ USER.md profile with a hard token budget + cache-prefix injection |

## 7. Risks & decisions

**Resolved** (was open): tokenizer = **trigram + query-layer LIKE fallback**;
cascade consistency = **external-content FTS5 with `'delete'`-command
triggers**, verified under cascade-delete.

**Live risks:**

- **Mid-stream UPDATE churn / empty-partial rows** — the trigger contract must
  skip empty/non-final content (§4 A).
- **Auto-section marker enforcement is prompt-only today** — must become the
  deterministic applier (§4 B) before any apply path ships.
- **Per-page archive does not exist yet** — `wiki-archive.ts` only does
  whole-tree zip; the archive+restore primitive is net-new.
- **Wiki-mutation concurrency** — reuse `syncChain`; reject stale proposals.
- **④ always-inlined cost/privacy** — hard char budget + cache-prefix + UI
  disclosure.

## 8. Billing note

The regular wiki is pointer-injected, but a leaner/deduped wiki still cuts the
tokens read on turns the agent consults it — a recurring per-turn saving that
compounds with the billing/PTY direction. (USER.md is the inlined exception
and must stay bounded.)

## 9. Consensus review summary

A 4-lens panel (architecture, pinloom-fit, SQLite-FTS5, UX) reviewed the prior
draft; three reviewers verified FTS behavior empirically against the project's
SQLite 3.53.0. Outcome folded into the doc above. Headline corrections that
were **non-negotiable before build**: (1) trigram's 3-char floor needs the
LIKE fallback or it's a silent-correctness cliff for a Korean-primary user;
(2) the FTS trigger must not collide with mid-stream content UPDATEs / empty
rows; (3) Phase 2's safety mechanisms (marker applier, archive-not-delete) must
be real code, not prompts — hence the 2a/2b split. Cuts for v1: background
gardening, free-form LLM diffs, jump-to-message.
