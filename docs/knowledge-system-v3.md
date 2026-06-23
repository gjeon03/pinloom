# pinloom Knowledge System v3 — the automatic knowledge flywheel

Status: **design / vision — NO code yet, decisions PENDING.** Successor to
`knowledge-system-v2.md`. Reference-driven by
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

- **Work Timeline = separate type** *(recommended)* vs mixed into the wiki.
- **Capture trigger** — ✅ **DECIDED**: passive only (never tab-close — it
  deletes). Primary = **idle-debounce + daily roll-up**; bonus = git commit;
  always-on = manual ("정리해줘" / hand a session id). Idle = incremental
  drafting per session during the day; daily roll-up = once-a-day consolidation
  + safety net.
- **Schedule-bot relationship** = timeline-substrate + bot-surface
  *(recommended)* vs bot owns it entirely.
- **Scope** = per-project timeline *(recommended)* + a global roll-up view.
- **Embedding backend** = deferred to build phase (local daemon / in-process
  model / cloud), pluggable, degrade-to-FTS when absent.

> The user has flagged **more to discuss** before locking these. This section is
> the live agenda.

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
