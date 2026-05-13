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
  {
    id: 20,
    // Persist the SDK's WorkerState for each remote-control-enabled
    // session so a backend restart can resume the same bridge worker
    // (perpetual: true reuses env + session id via bridge-pointer.json
    // on the SDK side; this table is the pinloom-side mirror the SDK
    // asks us to manage). One row per session. We do NOT overload
    // `sessions.claude_session_id` — that column carries the local
    // adapter's resume token, which has different ownership semantics
    // than the bridge worker's session id.
    sql: `
      CREATE TABLE IF NOT EXISTS bridge_state (
        session_id          TEXT PRIMARY KEY,
        bridge_session_id   TEXT,
        claude_session_id   TEXT,
        last_sse_seq        INTEGER,
        updated_at          TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    insertMigration.run(migration.id, new Date().toISOString());
  }
}
