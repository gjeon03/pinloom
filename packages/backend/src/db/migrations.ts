import type Database from 'better-sqlite3';

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        cwd         TEXT NOT NULL UNIQUE,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'draft',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id);

      CREATE TABLE IF NOT EXISTS plan_items (
        id          TEXT PRIMARY KEY,
        plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        parent_id   TEXT REFERENCES plan_items(id) ON DELETE CASCADE,
        order_index INTEGER NOT NULL DEFAULT 0,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'todo',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id);
      CREATE INDEX IF NOT EXISTS idx_plan_items_parent ON plan_items(parent_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        plan_id            TEXT REFERENCES plans(id) ON DELETE SET NULL,
        claude_session_id  TEXT,
        title              TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        plan_item_id  TEXT REFERENCES plan_items(id) ON DELETE SET NULL,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        tool_use      TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_plan_item ON messages(plan_item_id);
    `,
  },
  {
    id: 2,
    sql: `
      ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN pin_title TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
    `,
  },
  {
    id: 3,
    sql: `
      ALTER TABLE sessions ADD COLUMN seed_context TEXT;
      ALTER TABLE sessions ADD COLUMN source_session_id TEXT;
    `,
  },
  {
    id: 4,
    sql: `
      ALTER TABLE messages ADD COLUMN source_message_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source_message_id);
    `,
  },
  {
    id: 5,
    sql: `
      ALTER TABLE projects ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;
      UPDATE projects
         SET order_index = (
           SELECT COUNT(*) FROM projects p2 WHERE p2.created_at > projects.created_at
         );
      CREATE INDEX IF NOT EXISTS idx_projects_order ON projects(order_index);
    `,
  },
  {
    id: 6,
    sql: `
      ALTER TABLE sessions ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions
         SET order_index = (
           SELECT COUNT(*) FROM sessions s2
           WHERE s2.project_id = sessions.project_id AND s2.created_at < sessions.created_at
         );
      CREATE INDEX IF NOT EXISTS idx_sessions_order ON sessions(project_id, order_index);
    `,
  },
  {
    id: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS terminals (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_terminals_project_order
        ON terminals(project_id, order_index);
    `,
  },
  {
    id: 8,
    sql: `
      ALTER TABLE messages ADD COLUMN pinned_at TEXT;
      UPDATE messages SET pinned_at = created_at WHERE pinned = 1;
      CREATE INDEX IF NOT EXISTS idx_messages_pinned_at
        ON messages(session_id, pinned_at);
    `,
  },
  {
    id: 9,
    sql: `
      ALTER TABLE sessions ADD COLUMN next_image_number INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    id: 10,
    sql: `
      ALTER TABLE sessions ADD COLUMN last_synced_message_id TEXT;
    `,
  },
  {
    id: 11,
    sql: `
      ALTER TABLE messages ADD COLUMN model TEXT;
    `,
  },
  {
    id: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS project_groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      ALTER TABLE projects
        ADD COLUMN group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id, order_index);
    `,
  },
  {
    id: 13,
    // Per-session agent kind ('claude' | 'codex'). agent_session_id replaces
    // the Claude-specific claude_session_id for resume tokens — Codex calls
    // these "thread_id"s, but the column stores either. We backfill from
    // claude_session_id so existing Claude sessions still resume cleanly.
    // claude_session_id stays for now to avoid breaking any in-flight reads;
    // a future migration can drop it once all callers have moved over.
    sql: `
      ALTER TABLE sessions
        ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
      ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;
      UPDATE sessions SET agent_session_id = claude_session_id;
    `,
  },
  {
    id: 14,
    // User-managed environment variables exposed to every agent run.
    // Loaded into process.env on backend startup and kept in sync on every
    // upsert/delete, so the Bash tool sees them without any per-session
    // wiring. is_secret=1 controls UI masking; not a security boundary.
    sql: `
      CREATE TABLE IF NOT EXISTS user_env (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        description TEXT,
        is_secret   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    id: 15,
    // Per-session pending message queue. The chat UI enqueues here when the
    // user types while an agent run is in flight; the runner drains this
    // table at every turn boundary (intra-turn natural break + end-of-turn)
    // and splices the queued messages into the agent via silent abort +
    // resume. Lives in SQLite so it survives backend restarts and tab
    // switches — the frontend just mirrors the table via WS broadcasts.
    sql: `
      CREATE TABLE IF NOT EXISTS message_queue (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        model       TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_queue_session
        ON message_queue(session_id, created_at);
    `,
  },
  {
    id: 16,
    // Teams group an orchestrator session with one or more worker sessions.
    // The orchestrator (a regular session) addresses workers by alias via
    // the pinloom MCP server; each worker keeps its own systemPrompt /
    // model / agent and stays usable as a standalone session. A session
    // is the orchestrator of at most one team and a worker of at most one
    // team, but can be neither (the default for existing sessions).
    sql: `
      CREATE TABLE IF NOT EXISTS teams (
        id                       TEXT PRIMARY KEY,
        name                     TEXT NOT NULL,
        -- A team is unusable without an orchestrator (the runner needs a
        -- session id to attribute MCP calls to). Cascading on delete keeps
        -- "team has workers but no orchestrator" out of the data model
        -- entirely — the alternative (SET NULL) would leave PR2's MCP
        -- server unable to resolve teams from the orchestrator's env.
        orchestrator_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_orchestrator
        ON teams(orchestrator_session_id)
        WHERE orchestrator_session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS team_members (
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        alias       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (team_id, session_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_session
        ON team_members(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_alias
        ON team_members(team_id, alias);
    `,
  },
  {
    id: 17,
    // Per-worker persona + tags. Persona is a short markdown blurb the
    // orchestrator can lean on when picking which worker to dispatch
    // to, and which we inject into the worker's systemPrompt at run
    // time so it actually plays the role. Tags are short identifiers
    // (e.g. "backend", "tests") with a future use of "broadcast to all
    // workers tagged X" — for now they're metadata only.
    //
    // Both columns are nullable so existing memberships keep working
    // unchanged, and so workers can opt out (a generalist worker
    // doesn't need a persona).
    sql: `
      ALTER TABLE team_members ADD COLUMN persona TEXT;
      ALTER TABLE team_members ADD COLUMN tags TEXT;
    `,
  },
  {
    id: 18,
    // Rename `persona` → `instructions`. The original name was too
    // narrow — users actually put a mix of identity, guidelines,
    // do/don'ts, and output conventions into that field, so a more
    // general "instructions" label matches the industry convention
    // (Anthropic system prompt / OpenAI custom GPT instructions /
    // Cursor rules) and the freeform usage we already encourage.
    // SQLite supports RENAME COLUMN since 3.25 and better-sqlite3
    // ships well past that.
    sql: `
      ALTER TABLE team_members RENAME COLUMN persona TO instructions;
    `,
  },
  {
    id: 19,
    // Mirror of team_members.instructions on the team itself, so the
    // orchestrator session has its own role briefing — the existing
    // workaround was pinning a message or maintaining a wiki page,
    // both of which are friction. Same nullable + 4000-char shape as
    // the worker version.
    sql: `
      ALTER TABLE teams ADD COLUMN instructions TEXT;
    `,
  },
  // Note: ids 20 and 21 were used by the remote-control feature that
  // was reverted in PR #80. Some developer DBs may still have those
  // entries in `schema_migrations`; we skip to 22 to avoid collision.
  {
    id: 22,
    // Composite index for (session_id, created_at) so paginated reads
    // (`SELECT … WHERE session_id = ? ORDER BY created_at`) can serve
    // ORDER BY from the index without a temp B-tree sort. Hot paths:
    // listMessages (UI initial fetch), loadRecentHistory (resume
    // fallback), and queue-drain reads.
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);
    `,
  },
  {
    id: 23,
    // Generic key/value store for app-level settings that aren't
    // user_env variables. First user: the GitHub backup feature
    // (PAT, remote URL, last sync timestamp). PAT is stored in plain
    // text — the UI warns the operator that the DB file leaking is
    // equivalent to the token leaking. Same trust boundary as user_env.
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 24,
    // Per-session model + reasoning effort, both nullable so a session
    // can defer to the agent's default. Stored on the session row so
    // the choice survives the GitHub backup → other-machine import flow
    // (localStorage was per-browser).
    sql: `
      ALTER TABLE sessions ADD COLUMN model TEXT;
      ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
    `,
  },
  {
    id: 25,
    // Per-project notepads: free-form notes that appear as tabs next to
    // chat sessions. `root` is a JSON split tree of text panes. Lives in
    // the DB (not localStorage) so notes back up with the project state.
    sql: `
      CREATE TABLE IF NOT EXISTS project_notepads (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        root        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_notepads_project
        ON project_notepads(project_id, position);
    `,
  },
  {
    id: 26,
    // Terminal-chat mode groundwork (docs/terminal-chat-mode-plan.md).
    // - messages.transcript_uuid: the Claude transcript line uuid a message was
    //   captured from. Shared dedupe key between the runner writer and the
    //   background transcript-capture writer so the two never double-insert a turn.
    // - sessions.transport: the transport chosen at session creation
    //   ('sdk' | 'pty' | 'terminal'), pinned per-session so flipping the global
    //   PINLOOM_CLAUDE_TRANSPORT env mid-life doesn't strand an existing session.
    // - sessions.last_captured_transcript_uuid: the capture cursor (the last
    //   transcript uuid folded into messages). DISTINCT from last_synced_message_id,
    //   which is the wiki-sync cursor — do not conflate.
    sql: `
      ALTER TABLE messages ADD COLUMN transcript_uuid TEXT;
      ALTER TABLE sessions ADD COLUMN transport TEXT;
      ALTER TABLE sessions ADD COLUMN last_captured_transcript_uuid TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_transcript_uuid
        ON messages(transcript_uuid);
    `,
  },
  {
    id: 27,
    // Make the (session_id, transcript_uuid) dedupe key REAL. Migration 26's
    // comment claimed the index prevented double-inserts, but a plain index
    // doesn't — dedupe relied solely on the capture writer's in-memory `seen`
    // set, which resets every process start, so a resume re-scan could fold an
    // already-captured turn twice. First collapse any such existing duplicates
    // (keep the earliest row per key), then enforce uniqueness. Partial on
    // transcript_uuid IS NOT NULL: SDK/codex/user rows have NULL and must stay
    // freely insertable. persistMessage now uses INSERT OR IGNORE against this.
    sql: `
      DELETE FROM messages
      WHERE transcript_uuid IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM messages
          WHERE transcript_uuid IS NOT NULL
          GROUP BY session_id, transcript_uuid
        );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_transcript_uuid
        ON messages(session_id, transcript_uuid)
        WHERE transcript_uuid IS NOT NULL;
    `,
  },
  {
    id: 28,
    // Dispatch job records — the durable, transport-agnostic source of truth
    // for one orchestrator→worker turn (docs/teams-dispatch-redesign.md).
    // Replaces the scattered, transport-specific polling that team_status/
    // team_wait/team_read used to do (runner activeRuns vs dispatch lock vs
    // the messages table). One row per dispatch; the id is the handle a
    // long task is reconnected through.
    //
    // FK policy is deliberate:
    //  - team_id REFERENCES teams ON DELETE CASCADE — a dispatch without its
    //    team is meaningless; deleting a team cleans its dispatches.
    //  - worker_session_id / orchestrator_session_id have NO FK. Worker
    //    sessions are ephemeral (closing a tab hard-deletes them), but a
    //    dispatch is an audit/handle record that must outlive that. A row
    //    whose worker vanished is swept to failed(worker_gone) by the
    //    recovery sweep, not cascaded away.
    //
    // last_progress is added now (unused until P2's progress stream) so a
    // later phase doesn't need a second migration.
    sql: `
      CREATE TABLE IF NOT EXISTS dispatches (
        id                       TEXT PRIMARY KEY,
        team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        worker_session_id        TEXT NOT NULL,
        orchestrator_session_id  TEXT,
        idempotency_key          TEXT,
        prompt                   TEXT NOT NULL,
        state                    TEXT NOT NULL,  -- queued|running|done|failed|timeout|cancelled
        stop_reason              TEXT,           -- end_turn|error|aborted|null
        reply                    TEXT,
        error                    TEXT,
        last_progress            TEXT,
        created_at               TEXT NOT NULL,
        started_at               TEXT,
        ended_at                 TEXT,
        updated_at               TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_worker
        ON dispatches(worker_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dispatches_team
        ON dispatches(team_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_idempotency
        ON dispatches(team_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    id: 29,
    // Full-text search over conversation history (docs/knowledge-system-v2.md,
    // Phase 1). External-content FTS5 mirroring messages.content — keeps the
    // index lean (no second copy of the text on disk) while still serving
    // snippet()/highlight() (a contentless table cannot).
    //
    // Tokenizer = trigram: the only viable choice for a Korean+English user.
    // ICU is not compiled into the bundled better-sqlite3, and unicode61
    // cannot segment Korean (returns 0 rows for Korean substring queries).
    // Trigram only matches at >= 3 chars; 1-2 char Korean terms (배포, 인증)
    // are served by a base-table LIKE in the query layer (see message-search.ts).
    //
    // The triggers are deliberately GUARDED to mirror exactly what gets
    // indexed, because an external-content FTS5 'delete' must correspond to a
    // real prior insert or it corrupts the index:
    //  - index ONLY role IN ('user','assistant') with non-empty content. Skip
    //    tool rows (noise + privacy) and the empty-content placeholder rows
    //    persistMessage creates (runner.ts then UPDATEs content on every
    //    closeStream flush — the AFTER UPDATE OF content trigger handles the
    //    empty->real transition without ever issuing a stray 'delete').
    //  - AFTER DELETE / the delete half of AFTER UPDATE only fire when the OLD
    //    row was actually indexed, so cascade-deletes (a session delete cascades
    //    to its messages with foreign_keys=ON, set in connection.ts) leave the
    //    index empty and passing FTS5 integrity-check.
    // Verified empirically against SQLite 3.53.0 (the bundled build).
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='trigram remove_diacritics 1'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
        WHEN new.content <> '' AND new.role IN ('user', 'assistant')
      BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
        WHEN old.content <> '' AND old.role IN ('user', 'assistant')
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          SELECT 'delete', old.rowid, old.content
          WHERE old.content <> '' AND old.role IN ('user', 'assistant');
        INSERT INTO messages_fts(rowid, content)
          SELECT new.rowid, new.content
          WHERE new.content <> '' AND new.role IN ('user', 'assistant');
      END;

      -- External-content tables start empty; backfill existing history.
      -- NOT the FTS5 'rebuild' command: rebuild repopulates from the WHOLE
      -- content table, so it would index the very tool/empty rows the triggers
      -- skip — and those rows can never be removed cleanly later (the guarded
      -- AFTER DELETE trigger won't fire for them), leaving stale index entries.
      -- Mirror the trigger filter exactly instead.
      INSERT INTO messages_fts(rowid, content)
        SELECT rowid, content FROM messages
        WHERE content <> '' AND role IN ('user', 'assistant');
      INSERT INTO messages_fts(messages_fts) VALUES ('optimize');
    `,
  },
  {
    id: 30,
    // Reusable prompt templates the user registers once and inserts into the
    // chat composer. User-level / global (no project_id, no FK) — like
    // user_env/app_settings, they apply to every session regardless of project,
    // and global means deleting a project never silently drops templates.
    // Manually ordered via order_index (no usage tracking in v1).
    sql: `
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        order_index  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_templates_order
        ON prompt_templates(order_index);
    `,
  },
  {
    id: 31,
    // Wiki gardener proposals (docs/knowledge-system-v2.md, Phase 2a). A
    // durable staging table: the gardener (Phase 2b) writes proposed changes
    // here; the user reviews and accepts/rejects them. Applying a proposal
    // routes through the deterministic wiki-curation primitives (#125) — the
    // agent never writes pages directly. base_hash pins the page version the
    // proposal was computed against, so a stale proposal is rejected at accept
    // time rather than clobbering an intervening edit.
    sql: `
      CREATE TABLE IF NOT EXISTS wiki_proposals (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,                    -- edit_section | archive_page
        status      TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | rejected
        title       TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        payload     TEXT NOT NULL,                    -- JSON, kind-specific
        base_hash   TEXT,                             -- sha256 of the target page at proposal time
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_proposals_status
        ON wiki_proposals(status, created_at);
    `,
  },
  {
    id: 32,
    // Built-in bots (schedule / skill). A bot is a normal session with a fixed
    // persona, hosted in a hidden project so it never clutters the project
    // sidebar or session pickers. `sessions.bot_kind` flags the persona (NULL
    // for ordinary sessions); `projects.hidden` keeps the bot host project out
    // of the project list. Bot config (e.g. the schedule journal path) lives in
    // files under ~/.pinloom/bots/, not the DB — user-inspectable and the same
    // "memory on disk the user controls" convention as the wiki.
    sql: `
      ALTER TABLE sessions ADD COLUMN bot_kind TEXT;
      ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 33,
    // Work Timeline (L1) capture (docs/knowledge-system-v3.md §12). The timeline
    // ENTRIES live as markdown files under ~/.pinloom/timeline/ (not the DB) —
    // only the capture bookkeeping is here. `projects.timeline_auto` is the
    // per-project automatic-capture toggle (default ON). `timeline_capture_state`
    // is the per-session cursor (last message distilled into the timeline), so
    // the background sweep is idempotent + resumable across restarts. Plain
    // ALTER/CREATE — no extension dependency.
    sql: `
      ALTER TABLE projects ADD COLUMN timeline_auto INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS timeline_capture_state (
        session_id                TEXT PRIMARY KEY,
        last_captured_message_id  TEXT,
        last_captured_at          TEXT
      );
    `,
  },
  {
    id: 34,
    // Timeline semantic indexing bookkeeping (knowledge-system-v3 fast-follow).
    // The timeline ENTRIES (markdown files) get vector-indexed into the lazily-
    // created `timeline_vectors` vec0 table so search/Recap span them too. This
    // PLAIN table tracks the content hash last embedded per entry so re-distilled
    // entries re-embed and unchanged ones are skipped. doc_id = `${projectId}:${date}`
    // (projectId is the durable key — the on-disk slug is rename-unstable). No
    // extension dependency here → boot-safe even when sqlite-vec can't load.
    sql: `
      CREATE TABLE IF NOT EXISTS timeline_index_state (
        doc_id        TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        indexed_at    TEXT
      );
    `,
  },
  {
    id: 35,
    // Wiki (L2) semantic indexing bookkeeping — same pattern as timeline (id 34).
    // The wiki PAGES (~/.pinloom/wiki/pages/*.md) get vector-indexed into the
    // lazily-created `wiki_vectors` vec0 table so ⌘K search + Recap span the
    // curated convention notes too — completing the L0/L1/L2 corpus. doc_id is the
    // page slug (filename sans .md). Plain table → boot-safe without the extension.
    sql: `
      CREATE TABLE IF NOT EXISTS wiki_index_state (
        doc_id        TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        indexed_at    TEXT
      );
    `,
  },
  {
    id: 36,
    // Auto wiki generation: a background sweep periodically re-runs the
    // conventions analyzer per project and STAGES the result as a replace_page
    // proposal (the human gate stays — wiki is injected into every prompt).
    // `projects.wiki_auto` is the per-project opt-out (default on). The state
    // table tracks what was last analyzed so the sweep only spends an LLM call
    // when enough new work has accrued + a min interval has passed.
    sql: `
      ALTER TABLE projects ADD COLUMN wiki_auto INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS wiki_analyze_state (
        project_id     TEXT PRIMARY KEY,
        last_message_at TEXT,
        last_run_at    TEXT
      );
    `,
  },
  {
    id: 37,
    // Per-session "Session Timeline" handover doc: a generated markdown digest
    // (structured summary + day-by-day detail). One row per session, regenerated
    // on demand. Kept in the DB so it backs up + survives ~/.claude resets.
    sql: `
      CREATE TABLE IF NOT EXISTS session_timelines (
        session_id   TEXT PRIMARY KEY,
        markdown     TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 38,
    // Per-day distilled notes cache for the Session Timeline. Lets regeneration
    // re-distill ONLY the days whose content changed (content_hash mismatch) —
    // a month-long session then costs ~the latest day per regen instead of
    // re-distilling everything. Keyed (session_id, date); content_hash covers
    // that day's message set so a stable past day is a cache hit.
    sql: `
      CREATE TABLE IF NOT EXISTS session_timeline_days (
        session_id   TEXT NOT NULL,
        date         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        markdown     TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, date)
      );
    `,
  },
  {
    id: 39,
    // Fun stat: how many times each skill the AI invoked (via the `Skill` tool)
    // through pinloom. Keyed by the skill name from the tool_use input; counted
    // forward as turns are captured (terminal + SDK both flow through
    // persistMessage). Surfaced as a badge on the Skills page.
    sql: `
      CREATE TABLE IF NOT EXISTS skill_usage (
        name         TEXT PRIMARY KEY,
        count        INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      );
    `,
  },
  {
    id: 40,
    // Fast "pending messages" lookup for the vector indexer. The old query did
    // `id NOT IN (SELECT doc_id FROM message_vectors)`, forcing a full scan of
    // the vec0 virtual table every 5s sweep (~100ms, even when idle) — the
    // event-loop blocker. Mirror the timeline/wiki indexers: track indexed
    // message ids in a plain indexed table so "pending" is an O(log n) anti-join.
    sql: `
      CREATE TABLE IF NOT EXISTS message_index_state (
        doc_id     TEXT PRIMARY KEY,
        indexed_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 41,
    sql: `
      CREATE TABLE IF NOT EXISTS codex_context_state (
        session_id                    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens                  INTEGER,
        cached_input_tokens           INTEGER,
        context_window_tokens         INTEGER,
        observed_compactions          INTEGER NOT NULL DEFAULT 0,
        post_compaction_input_tokens  INTEGER,
        rollout_bytes                 INTEGER,
        awaiting_post_compaction      INTEGER NOT NULL DEFAULT 0,
        rollout_identity              TEXT,
        observed_complete_offset      INTEGER NOT NULL DEFAULT 0,
        observation_generation        TEXT,
        updated_at                    TEXT NOT NULL
      );
    `,
  },
  {
    id: 42,
    sql: `
      CREATE TABLE claude_transcript_state (
        session_id             TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        transcript_identity    TEXT NOT NULL,
        complete_offset        INTEGER NOT NULL,
        last_transcript_uuid   TEXT,
        last_conversation_type TEXT CHECK(last_conversation_type IN ('user', 'assistant') OR last_conversation_type IS NULL),
        updated_at             TEXT NOT NULL
      );
    `,
  },
];

export function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id),
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );

  // Apply each migration + record it atomically: a multi-statement migration
  // (e.g. 29's vtable + triggers + data backfill) that dies mid-exec must roll
  // back entirely rather than leave a half-applied, unrecorded migration that
  // re-runs (and double-applies its non-idempotent backfill) on next boot.
  const applyOne = db.transaction((migration: { id: number; sql: string }) => {
    db.exec(migration.sql);
    insertMigration.run(migration.id, new Date().toISOString());
  });

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    applyOne(migration);
  }
}
