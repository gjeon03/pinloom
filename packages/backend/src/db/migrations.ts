import type Database from 'better-sqlite3';

const MIGRATIONS: { id: number; sql: string }[] = [
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
