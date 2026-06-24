# pinloom Knowledge System v3 — the automatic knowledge flywheel

Status: **design locked; Phase 1 in build** (build plan + spike results +
adversarial-review fixes in §11). Successor to `knowledge-system-v2.md`. Reference-driven by
[Tencent/WeKnora](https://github.com/Tencent/WeKnora) and the broader
"personal second brain" category (Khoj, Obsidian Smart Connections,
Karpathy-style self-growing LLM wiki, Graphify / codebase-memory). This doc
captures a design conversation so it survives context loss; **open questions in
§8 are still being discussed with the user.**

## 1. Why this doc / where v2 left off

v2 shipped pinloom's *curation + findability* layer: FTS5 session search (⌘K),
the wiki gardener (dedup/merge/prune-to-archive), automatic sync suggestion,
and the USER.md profile. All merged. v2's reference was hermes-agent.

v3 is the **next altitude**: turn pinloom's *accumulating* corpus into a
**living, automatic knowledge flywheel** — knowledge that piles up by itself,
organizes itself, links itself for easy viewing, and is reachable by *meaning*
(not just keywords), with the agent able to *answer from it* (RAG), not just
return links.

The user's own words for what they want:

> "자동으로 지식이 쌓이고 → 이게 정리되고 → 보기 편하게 이어지고 → 간편하게 조회되고."

pinloom already nails step 1 (durable session capture). v3 closes 2–4.

## 2. pinloom's unfair advantage (the framing that matters)

Khoj / WeKnora **ingest already-made documents after the fact**. pinloom sits
**at the point where the knowledge is generated** — the coding conversation
itself — and already owns agents, MCP, the wiki, the gardener, teams, and bots.

The sharpest consequence, and the keystone of this whole design:

> **git has the WHAT (diffs, commits). pinloom has the WHY (the conversation,
> the reasoning, the discarded options).** Joining them per-day produces a
> *dev journal with rationale* that neither git nor a plain journal app can
> produce — and that is exactly the raw material for "what was I doing and why
> at time T", and for auto-generating a portfolio / résumé.

So v3 is **not** "bolt on a RAG product." It is "wake up the corpus pinloom is
already accumulating."

## 3. Three knowledge layers (keep them distinct, search them as one)

| Layer | Nature | Source | Lifecycle |
|-------|--------|--------|-----------|
| **L0 Sessions** | the raw source; conversation = WHY | accumulates just by using pinloom (exists today) | immutable |
| **L1 Work Timeline** ⟵ *new in v3* | dated "what I did + why on day D" + the commits | auto-distilled from L0 sessions + git | append-only (history) |
| **L2 Convention Wiki** | timeless "how we do X" | gardener distills from L0 | curated / deduped |

**Design rule: do NOT merge L1 into L2.** Their lifecycles are opposite — a
journal is *kept* (append-only history); a convention is *tightened and merged*
(curation). Today's wiki feels "convention-heavy" because that is correctly L2;
the work journal is a **new sibling type**, not pages mixed into the wiki.

**But all three live in ONE semantic corpus** (§4) so they are searched and
reasoned over together.

## 4. RAG: adopt the capability, in-process — NOT a Docker service

Why people use RAG over plain document lookup (the user asked):

1. **It answers** — synthesizes a result, instead of handing you a pile of
   links to read.
2. **It recalls by meaning** — embeddings find relevant material even when the
   wording differs (esp. important for Korean, where the current trigram FTS is
   weak).
3. **It synthesizes across many sources** — stitches session A + wiki B +
   decision C into one answer.
4. **It grounds + cites** — answers from *your* data with sources, and selects
   only the relevant slice so the corpus can exceed the context window.

So the RAG *capability* = the flywheel's retrieval (③) and reasoning (deep
research) steps. **Adopt it.**

**But running RAG as a separate Docker service (WeKnora-style pgvector / ES /
Milvus + a RAG microservice) is the wrong shape for pinloom:**

- **The "G" already exists.** pinloom already runs the Claude Agent SDK. It
  needs the "R" (retrieval) fed into the LLM it already has — not a whole RAG
  service (half of which would be redundant).
- **Two sources of truth.** The wiki lives in `~/.pinloom/wiki`; a separate
  Docker RAG would ingest *copies* → sync/drift, the exact problem the gardener
  exists to prevent.
- **Vectors fit in the existing SQLite.** No separate vector DB / container —
  the embeddings live in `data/pinloom.sqlite` (via a SQLite vector extension),
  honoring the design rule *"pinloom's SQLite owns everything."*
- **Local / lightweight identity.** A standing container is a new process and
  ops surface, against pinloom's grain.

**A Docker RAG would only make sense for** team / multi-user, millions of docs,
swappable heavyweight vector DBs, or reuse outside pinloom — none of which apply
to a single user's wiki + sessions.

**→ pinloom's answer: in-process RAG.** Retrieval = embeddings + vectors *inside
the existing SQLite*, hybrid with the existing FTS. Generation = the existing
agent. The only "external" piece is an **embedding model**, which is pluggable
and optional (graceful-degrade to lexical FTS if absent) — and that is just an
embedder, not "RAG in Docker." Embedding-backend choice (local daemon vs
in-process model vs cloud) is deferred to the build phase, not decided here.

## 5. The flywheel — end-to-end user flow

**① Just work as usual**
- Coding conversations (sessions) auto-persist → WHY. *(exists)*
- The project's git commits / dates → WHAT. *(new input)*

**② It organizes itself (background, no buttons)**
- Capture is **passive — the user never closes/finishes anything by hand.** It
  rides signals that happen anyway: a session going **idle** (debounced, the
  primary trigger), a **daily roll-up** sweep (safety net), and/or a **git
  commit** (the natural WHAT-done moment). It must NEVER trigger on tab-close —
  in pinloom closing a tab *deletes* the session (`deleteSession`), so capture
  has to happen continuously, before any disposal. (This is what makes
  pinloom's "sessions are disposable, the durable layer is the wiki/timeline"
  design actually safe: knowledge is distilled out before a session is thrown
  away.)
- On those triggers an agent distills that day's work — *what, why, which
  decisions* — and correlates the relevant commits → writes/updates a **Work
  Timeline entry (L1)** (incremental update of the day's entry, debounced +
  deduped, so it's cheap). Intent comes from the conversation; changes come
  from git.
- The gardener pulls only *reusable conventions* into the wiki (L2). *(evolves
  the existing button-driven gardener toward automatic)*
- Everything new is indexed into the **SQLite vector store** (RAG's R).

**③ It connects, nicely viewable**
- **Timeline view** (calendar / chronological): "6/23 — bot foundation +
  schedule bot, 3 commits, 2 key decisions, links to sessions & wiki."
- **Wiki graph view**: pages linked by `related:` (which already exists as
  frontmatter) + auto-suggested links.
- Entry ↔ session ↔ commit ↔ wiki are click-connected.

**④ Query by meaning + answer via RAG (in-process)**
- One corpus (sessions + timeline + wiki) searched by meaning, hybrid with FTS;
  the existing agent answers with citations.
- Everyday: *"what did I do in June?"*, *"what was I weighing during the billing
  work?"*
- Generative downstream: **"draft portfolio items from the last 3 months of
  work"**, **"turn this into résumé bullets"**, *"explain the reasoning behind
  that decision"* — the L1 timeline is precisely this material.

## 6. Relationship to the schedule bot (PR #131) — avoid two journals

The schedule bot already writes dated `YYYY-MM-DD.md` journals (todos + "done")
to a user-chosen path (Obsidian / local) and can ingest a session id. That
overlaps with L1. To avoid two competing journals:

- **L1 Work Timeline = the automatic *substrate*** (inside pinloom's corpus →
  searchable / RAG-able / feeds portfolio).
- **Schedule bot = the human-facing *surface*** (planning + "정리해줘").
- The bot **reads/writes the L1 timeline** → one timeline, two access modes
  (automatic capture + interactive bot). *(recommended; see §8)*

## 7. Shipping order (incremental — each phase has standalone value)

1. **Semantic corpus** — embeddings + SQLite vector store + hybrid with the
   existing FTS. The doorway; everything else reuses it.
2. **Work Timeline auto-capture** — sessions + commits → dated entries (the
   thing the user specifically asked for).
3. **Viewing** — timeline view + wiki graph view + auto-linking.
4. **RAG answers + downstream** — corpus Q&A, portfolio / résumé generation,
   "what / why at time T".
5. *(later)* **Expose the corpus over MCP** — so the IDE's Claude Code / Codex /
   the bots can query pinloom's knowledge from anywhere (synergizes with the
   skill bot + MCP server already shipped in PR #131).

## 8. Open decisions (PENDING — discuss before building; recommendation noted)

- **Work Timeline = separate type** — ✅ **DECIDED**: a distinct L1 type, NOT
  pages mixed into the convention wiki (L2). (Both still in the one semantic
  corpus, §4.)
- **Capture trigger** — ✅ **DECIDED**: passive only (never tab-close — it
  deletes). Primary = **idle-debounce + daily roll-up**; bonus = git commit;
  always-on = manual ("정리해줘" / hand a session id). Idle = incremental
  drafting per session during the day; daily roll-up = once-a-day consolidation
  + safety net.
- **Per-project auto-timeline toggle** — ✅ **DECIDED**: each project has an
  on/off switch for *automatic* timeline capture (idle + roll-up), **default
  ON**. Off = that project gets no auto-capture; manual capture (bot /
  "정리해줘") still works. Lets the user silence noisy/throwaway projects.
- **Schedule-bot relationship** — ✅ **DECIDED**: timeline = automatic
  *substrate* (in pinloom's corpus); schedule bot = human-facing *surface* that
  reads/writes it. One timeline, two access modes. (No duplicate journal.)
- **Scope / structure** — ✅ **DECIDED** (delegated): **per-project timeline**
  (entries scoped to a project's own sessions + that repo's commits — work is
  project-bound and commits are per-repo) + a **global cross-project date view**
  that aggregates the day across all projects ("what did I do on 6/24,
  everywhere"). The global view is a read-time aggregation, not a second store.
  Exact on-disk layout (e.g. `~/.pinloom/timeline/<project>/YYYY-MM-DD.md` vs
  inside the wiki tree) is a build-phase detail.
- **Embedding backend** — ✅ **DECIDED**: a **pluggable provider interface**
  with one job (text → vector). **Default = in-process** (pinloom runs a small
  embedding model itself, e.g. `multilingual-e5`; zero setup, fully local).
  **Ollama = a fast-follow adapter** behind the same interface (opt-in /
  selectable; e.g. `bge-m3` for top Korean quality). Cloud is intentionally NOT
  built (privacy: the corpus is private coding history). If no provider is
  available, **degrade to lexical FTS** (search still works, just keyword-only).
  Build order: ship in-process with Phase 1, add the Ollama adapter right after.

> Status: **all design decisions locked.** Ready to start Phase 1 (§7) — the
> semantic corpus (SQLite vector store + in-process embedding + hybrid-with-FTS).

## 9. Explicitly NOT doing

Full GraphRAG engine, multi-tenant / RBAC / audit / at-rest encryption,
external vector-DB containers (pgvector / Milvus / Neo4j / ES), MinIO / S3,
the dozens of IM / storage connectors, Kubernetes. All enterprise weight that a
single-user local app does not need.

## 10. References

- [Tencent/WeKnora](https://github.com/Tencent/WeKnora) — knowledge-asset
  philosophy, GraphRAG, ReACT, agent-generated wiki, multimodal.
- [Khoj](https://github.com/khoj-ai/khoj) — local second brain over files /
  PDFs / GitHub; deep research; Obsidian integration.
- Karpathy-style self-growing LLM wiki — an LLM that ingests notes/conversations
  and writes interlinked markdown that grows itself.
- [Graphify](https://flowtivity.ai/blog/graphify-knowledge-graph-coding-assistant/)
  / [codebase-memory MCP](https://github.com/DeusData/codebase-memory-mcp) —
  codebase → queryable knowledge graph; ADRs / decisions persisted across
  sessions; MCP as the standard transport.

---

## 11. Phase 1 build plan — semantic corpus (revised after adversarial review)

**Spike results (empirically verified, isolated scratch, prod untouched):**
- `sqlite-vec` (npm, prebuilt `vec0.dylib` darwin-arm64) loads into the
  project's better-sqlite3 12.9.0 under Node 24 via `db.loadExtension()`; vec0
  KNN (`WHERE embedding MATCH ? ORDER BY distance`) ranks correctly.
- In-process `Xenova/multilingual-e5-small` (transformers.js) embeds Korean,
  384-dim, ranking correct but **thin margin** (0.831 vs 0.819) → in-process is
  "good enough for ranking"; Ollama/bge-m3 is the quality upgrade (fast-follow).
- vec0 **DELETE by PK works**; vec0 **does NOT support UPSERT** → re-embed must
  be **delete+insert**; an `AFTER DELETE ON messages` **trigger CAN delete from
  the vec0 table** (orphan eviction works).

**Production-safety invariants (non-negotiable — prod is live):**
- **Vec table is created LAZILY after `loadExtension` succeeds, NEVER via the
  numbered-migration ledger** (H1). A `CREATE VIRTUAL TABLE vec0` inside a
  numbered migration would throw when the extension is absent → roll back →
  unrecorded → re-throw every boot = prod startup crash. Instead: `loadExtension`
  in `connection.ts` inside try/catch → `vectorSearchAvailable` flag; when true,
  run an idempotent `ensureVecTables()` (CREATE IF NOT EXISTS) at startup.
- **Inference does NOT block the event loop — worker_thread NOT needed** (H2,
  re-tested). The review assumed inference is hundreds of ms of main-thread CPU;
  an event-loop-lag spike showed otherwise: onnxruntime-node offloads matmuls to
  its native thread pool, so `await extractor(text)` yields. Measured: **2.6
  ms/embed, max event-loop lag 1.8 ms** over 30 in-process embeds. So the model
  runs in-process; the provider's `embedPassages` is **sequential (not
  Promise.all)** to bound memory, and the backfill still **yields to live
  traffic** between batches as defense-in-depth. (If a future heavier model
  changes this, the provider interface is unchanged — swap in a worker behind it.)
- **First-run model download is ACCEPTED, in the background** (H5, revised). The
  original plan was `allowRemoteModels=false` + pre-staging, but that breaks the
  "zero setup" promise (the model must come from somewhere). Decision: keep
  `allowRemoteModels=true`; the FIRST background warmup downloads ~120MB into
  `~/.pinloom/models`, then it's an offline cache hit forever. The invariant that
  actually matters — **never block a request on the network** — holds: the
  download is in the background warmup, search runs on FTS until ready, and a
  download failure is caught → degrade to FTS. Strict-offline → use the Ollama
  provider. Provider is **lazy-loaded** so a broken native addon degrades, never
  throws at import. (`onnxruntime-node` confirmed resolving under the pnpm
  workspace; load + 384-d Korean embedding spike-verified.)
- **Any failure (extension, model, worker) → degrade to pure lexical FTS** =
  exactly today's behavior. Search must never regress or error.
- Verify on isolated ports/test DB; never rebuild prod dist; deploy on user's
  timing (standard `pnpm build` + `launchctl kickstart -k`).

**Schema (source-agnostic from day 1 — M5):** vectors live in SQLite keyed by a
stable text id + a `source` discriminator, so wiki/timeline slot in later with NO
vec rebuild. Phase 1 indexes **messages only** (parity with today's ⌘K), but the
table is `doc_vectors(doc_id TEXT PRIMARY KEY, source TEXT, embedding float[384])`
(or per-source vec tables behind one interface). A meta row tracks
`(model_id, dim)`; a dim change is an **explicit, surfaced re-embed**, not a
silent boot-time drop (M3).

**Step A (#5) — Embedding provider interface + in-process impl**
- `EmbeddingProvider { id, dim, embedQuery(text), embedPassage(text) }` — note
  the **e5 asymmetry: store with `passage:`, search with `query:`** (L1, unit-
  tested both ways).
- `InProcessProvider` (transformers.js, multilingual-e5-small, mean-pool+
  normalize, lazy singleton in a worker_thread, length cap, localFilesOnly).
- `getEmbeddingProvider()` → provider | null (null ⇒ degrade). Tests mock the
  model.

**Step B (#6) — Vector store + indexing + backfill** ✅ *built as below*
- `connection.ts`: load sqlite-vec (try/catch → `isVectorAvailable()`);
  `vector-store.ts` creates the vec0 table LAZILY (never the migration ledger).
- **Indexing = periodic background SWEEP, not a write-path hook** (cleaner than
  the planned UPDATE-boundary hook, and zero runner coupling): `message-indexer.ts`
  drains `role IN ('user','assistant') AND content <> '' AND source_message_id IS
  NULL AND id NOT IN (message_vectors)` in throttled batches, yielding between
  each. The `content <> ''` predicate naturally skips the empty streaming
  placeholder (H3 satisfied without hooking `closeStream`); the `NOT IN` cursor
  makes it idempotent + resumable across restarts (M4) and unifies backfill with
  live indexing. New messages are searchable on the next sweep (seconds' lag —
  fine for history). Re-embed = **delete+insert** (vec0 has no upsert).
- **Delete-sync via periodic GC, NOT a trigger** (H4, revised): a persistent
  `AFTER DELETE` trigger referencing the vec0 table would break message/session
  deletes on any later boot where the extension failed to load. Instead
  `gcOrphans()` sweeps `doc_id NOT IN (SELECT id FROM messages)` after productive
  passes; doc_ids are nanoids (never reused) and dead hits drop at the search
  join, so orphans are harmless until GC.
- Inference is in-process (worker_thread unneeded — see above); the sweep yields
  to live traffic. Wired in `app.ts` boot, guarded `NODE_ENV !== 'test'`,
  degrade-safe.
- Confirm `db-export.ts`/`db-import.ts` don't open a second `new Database` that
  would lack the extension (L3).

**Step C (#7) — Hybrid search (RRF)**
- `vectorSearch(queryEmb)` → KNN → `messages.id` + distance.
- `searchMessages` fuses existing FTS + vector by **RRF (k=60)**, deduped by
  `messages.id` across the two id spaces (M2). When vector is unavailable →
  exactly today's FTS path (no regression).
- **Short-Korean LIKE-only path (M1):** that path has no bm25 ranking (recency
  sort), so do NOT feed it into RRF as a ranked list — return vector results when
  available, else the LIKE list as today (decided, not implicit).
- Excerpts/highlights unchanged; wire shape unchanged.

**Step D (#8) — Verify + review + PR**
- per-package `tsc --noEmit`, full backend tests, isolated E2E: (a) a semantic
  hit a keyword query misses, AND (b) a **keyword-query non-regression** guard vs
  today's pure-FTS ranking (L2). Adversarial review; fix; PR (incl. this doc).

**Review verdict:** REVISE→build; all HIGH (H1 lazy vec-table, H2 worker_thread,
H3 update-boundary, H4 delete-trigger, H5 install/model staging) and MED folded
in above. Sound to build.

---

## 12. Phase 2 build plan — Work Timeline (revised after adversarial review)

Verdict: REVISE → build (shape right; copy proven infra). 2A done.

**Canonicalization decision (H1):** `~/.pinloom/timeline/<slug>/YYYY-MM-DD.md` is
the **canonical, automatic L1 work-record**. The schedule bot's Obsidian journal
(PR #131) is a SEPARATE artifact — the user's *manual planning* surface — NOT a
duplicate of the timeline. **Bot↔timeline wiring is DEFERRED** out of Phase 2 (a
later task: a `pinloom_read_timeline` MCP tool so the bot can reference the
substrate). Phase 2 ships the substrate only → no two-journals problem.

**2B Distillation** (`timeline/distill.ts`): `distillDay({projectCwd, date,
sessions, commits, existingEntry, runAgent})` → markdown. Seam mirrors
`wiki-gardener.ts` (injectable runAgent; real SDK default, read-only). Manual
"정리해줘" and the sweep share this ONE entrypoint (L2). `gitCommitsForDay(cwd,
date)` via **`execFile('git', [...])`** (NO shell interpolation, M2), local-tz
boundaries (`--since="<date> 00:00" --until="<date> 23:59" --date=local`),
non-repo guard (`git -C cwd rev-parse` → empty commits, never throw).

**2C Capture trigger + state** (`timeline/capture.ts` + migration). Copy the
`message-indexer.ts` discipline verbatim (interval + `running` single-flight +
`unref` + try/catch + `NODE_ENV!=='test'` guard + resumable cursor).
- Migration: `projects.timeline_auto INTEGER NOT NULL DEFAULT 1` (plain ALTER,
  no extension dep — safe in the numbered ledger) + `timeline_capture_state(
  session_id PRIMARY KEY, last_captured_message_id, last_captured_at)`.
- **Pending selection (H2/H4/M5)** — one grouped query: sessions whose
  `MAX(messages.created_at) < now-15min`, that have a message id beyond their
  cursor with **substantive** new content, whose project `timeline_auto=1` and is
  not hidden/bot. At distill time re-check `!isAiRunning(sessionId)` AND queue
  depth 0 (select→distill race).
- **Roll-up**: at date change, finalize yesterday across projects via the SAME
  path.
- **Keyed single-flight (H3)**: an in-process `Map<`${slug}:${date}`, Promise>`
  mutex around read-modify-write of the day file (blind `writeEntry` overwrite is
  a data-loss path; both idle + roll-up share the lock; roll-up skips locked).
- **Cost bound (M1)**: per-(project,date) min re-distill interval (~30–60 min) +
  a substantive-delta floor (skip if < N new non-trivial chars since cursor).
- **Crash/delete (M3)**: advance every contributing session's cursor in ONE
  transaction ONLY after `writeEntry` succeeds → resumable; tolerate a
  deleted-mid-distill session (read transcript defensively, skip if gone).
- Wired in `app.ts` boot, degrade-safe, `NODE_ENV!=='test'`.

**2D Toggle + API + view** (NO bot wiring — deferred per H1): per-project
`timeline_auto` toggle (UI + API), `GET` timeline (project / date-range /
global-date-view), `POST` manual capture (→ same `distillDay`). UI maps
slug→project name (L3).

**Out of Phase 2 (L1):** vector-indexing timeline entries into the Phase-1 corpus
— a small fast-follow once the writer is stable (the `doc_vectors.source`
discriminator already supports it).

**De-risk order:** (1) 2C state model + keyed mutex + `isAiRunning` guard, tested
with a FAKE runAgent + isolated DB/home (no LLM/auth); (2) 2B git boundary; (3)
real SDK distill (verified in prod like the gardener).

---

## 13. Phase 5 — corpus over MCP (knowledge as infrastructure)

The pinloom MCP server (`packages/mcp-server`) gains a third mode, **corpus**,
that exposes the user's pinloom knowledge to EXTERNAL agents — their IDE's Claude
Code / Codex — so they can query it from anywhere, not just pinloom's UI. No
token: it calls pinloom's PUBLIC localhost routes (single-user, local-only).

Tools (corpus mode): `pinloom_search` (hybrid search over past conversations),
`pinloom_ask` (RAG answer grounded in history, cited), `pinloom_timeline` (a
day's Work Timeline). All hit existing public routes (`/api/search`,
`/api/recap/ask`, `/api/timeline/date/:date`) — additive, no backend change.

Mode selection (`index.ts`): `PINLOOM_CORPUS` → corpus; else `PINLOOM_BOT_TOKEN`
→ bot; else team. Team/bot unchanged (smoke-verified all three).

**Register it (user does this once, after a `pnpm build`):**

Claude Code:
```
claude mcp add pinloom-corpus -e PINLOOM_CORPUS=1 \
  -- node <repo>/packages/mcp-server/dist/index.js
```
Codex (`~/.codex/config.toml`):
```
[mcp_servers.pinloom-corpus]
command = "node"
args = ["<repo>/packages/mcp-server/dist/index.js"]
env = { PINLOOM_CORPUS = "1" }
```
Then in the IDE: "search my pinloom history for …" / "ask pinloom what I decided
about …". Requires the pinloom backend running on :4748 (the default; override
with `PINLOOM_BACKEND_URL`).
