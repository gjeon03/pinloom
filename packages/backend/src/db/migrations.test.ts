import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

// Apply only migrations with id <= maxId, then mark them as applied so a
// subsequent runMigrations() call only runs the remaining ones.
function applyUpTo(db: Database.Database, maxId: number) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (m.id > maxId) break;
    db.exec(m.sql);
    insert.run(m.id, new Date().toISOString());
  }
}

function tableInfo(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function indexNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('runMigrations', () => {
  it('applies every migration on a fresh database', () => {
    const db = freshDb();
    runMigrations(db);
    const applied = db
      .prepare('SELECT id FROM schema_migrations ORDER BY id ASC')
      .all() as { id: number }[];
    expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('is idempotent — running twice does not re-apply or fail', () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(count.n).toBe(MIGRATIONS.length);
  });

  it('creates the expected tables', () => {
    const db = freshDb();
    runMigrations(db);
    const names = tableNames(db);
    for (const t of [
      'projects',
      'plans',
      'plan_items',
      'sessions',
      'messages',
      'terminals',
      'schema_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('messages has all columns added through migration 11', () => {
    const db = freshDb();
    runMigrations(db);
    const cols = tableInfo(db, 'messages');
    for (const c of [
      'id',
      'session_id',
      'plan_item_id',
      'role',
      'content',
      'tool_use',
      'created_at',
      'pinned',
      'pin_title',
      'source_message_id',
      'pinned_at',
      'model',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('sessions has all columns added through migration 10', () => {
    const db = freshDb();
    runMigrations(db);
    const cols = tableInfo(db, 'sessions');
    for (const c of [
      'id',
      'project_id',
      'plan_id',
      'claude_session_id',
      'title',
      'created_at',
      'updated_at',
      'seed_context',
      'source_session_id',
      'order_index',
      'next_image_number',
      'last_synced_message_id',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('projects has order_index after migration 5', () => {
    const db = freshDb();
    runMigrations(db);
    const cols = tableInfo(db, 'projects');
    expect(cols).toContain('order_index');
  });

  it('creates the expected indexes', () => {
    const db = freshDb();
    runMigrations(db);
    const idx = indexNames(db);
    for (const n of [
      'idx_plans_project',
      'idx_plan_items_plan',
      'idx_plan_items_parent',
      'idx_sessions_project',
      'idx_messages_session',
      'idx_messages_plan_item',
      'idx_messages_pinned',
      'idx_messages_source',
      'idx_projects_order',
      'idx_sessions_order',
      'idx_terminals_project_order',
      'idx_messages_pinned_at',
    ]) {
      expect(idx).toContain(n);
    }
  });

  it('records each migration exactly once with an applied_at timestamp', () => {
    const db = freshDb();
    runMigrations(db);
    const rows = db
      .prepare('SELECT id, applied_at FROM schema_migrations')
      .all() as { id: number; applied_at: string }[];
    expect(rows.length).toBe(MIGRATIONS.length);
    for (const r of rows) {
      expect(r.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe('migration 5 — projects.order_index backfill', () => {
  it('newest project gets 0 and oldest gets N-1', () => {
    const db = freshDb();
    applyUpTo(db, 4);
    const ins = db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run('p-old', 'oldest', '/a', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    ins.run('p-mid', 'middle', '/b', '2021-01-01T00:00:00Z', '2021-01-01T00:00:00Z');
    ins.run('p-new', 'newest', '/c', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, order_index FROM projects')
      .all() as { id: string; order_index: number }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.order_index]));
    expect(byId['p-new']).toBe(0);
    expect(byId['p-mid']).toBe(1);
    expect(byId['p-old']).toBe(2);
  });
});

describe('migration 6 — sessions.order_index backfill (per-project)', () => {
  it('orders by created_at ascending and resets per project', () => {
    const db = freshDb();
    applyUpTo(db, 5);

    const insP = db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insP.run('pa', 'A', '/a', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    insP.run('pb', 'B', '/b', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

    const insS = db.prepare(
      'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    insS.run('sa1', 'pa', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    insS.run('sa2', 'pa', '2021-01-01T00:00:00Z', '2021-01-01T00:00:00Z');
    insS.run('sa3', 'pa', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
    insS.run('sb1', 'pb', '2020-06-01T00:00:00Z', '2020-06-01T00:00:00Z');

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, order_index FROM sessions')
      .all() as { id: string; order_index: number }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.order_index]));
    expect(byId['sa1']).toBe(0); // oldest in pa
    expect(byId['sa2']).toBe(1);
    expect(byId['sa3']).toBe(2);
    expect(byId['sb1']).toBe(0); // only session in pb
  });
});

describe('migration 8 — messages.pinned_at backfill', () => {
  it('sets pinned_at = created_at for pinned rows and leaves unpinned NULL', () => {
    const db = freshDb();
    applyUpTo(db, 7);

    db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p', 'P', '/p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

    db.prepare(
      'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('s', 'p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

    const insM = db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, pinned, pin_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insM.run('m-pinned', 's', 'user', 'hello', 1, 'note', '2020-02-02T00:00:00Z');
    insM.run('m-unpinned', 's', 'user', 'hi', 0, null, '2020-02-03T00:00:00Z');

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, pinned, pinned_at FROM messages')
      .all() as { id: string; pinned: number; pinned_at: string | null }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['m-pinned'].pinned_at).toBe('2020-02-02T00:00:00Z');
    expect(byId['m-unpinned'].pinned_at).toBeNull();
  });
});

describe('schema integrity', () => {
  it('foreign keys cascade plan_items when a plan is deleted', () => {
    const db = freshDb();
    runMigrations(db);
    db.pragma('foreign_keys = ON');

    db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p', 'P', '/p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO plans (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('pl', 'p', 'Plan', 'draft', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO plan_items (id, plan_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('it', 'pl', 'Item', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

    db.prepare('DELETE FROM plans WHERE id = ?').run('pl');

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM plan_items')
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('foreign keys set messages.plan_item_id NULL when the plan_item is deleted', () => {
    const db = freshDb();
    runMigrations(db);
    db.pragma('foreign_keys = ON');

    db.prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p', 'P', '/p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO plans (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('pl', 'p', 'Plan', 'draft', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO plan_items (id, plan_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('it', 'pl', 'Item', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('s', 'p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO messages (id, session_id, plan_item_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m', 's', 'it', 'user', 'hello', '2020-01-01T00:00:00Z');

    db.prepare('DELETE FROM plan_items WHERE id = ?').run('it');

    const row = db
      .prepare('SELECT plan_item_id FROM messages WHERE id = ?')
      .get('m') as { plan_item_id: string | null };
    expect(row.plan_item_id).toBeNull();
  });
});
