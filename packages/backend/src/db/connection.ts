import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './migrations.js';

const DEFAULT_DB_PATH = resolve(process.cwd(), '../../data/pinloom.sqlite');
const DB_PATH = process.env.PINLOOM_DB_PATH
  ? resolve(process.env.PINLOOM_DB_PATH)
  : DEFAULT_DB_PATH;

// Hard guard against the most likely cause of accidental data loss: a
// test (Playwright/Vitest/ad-hoc) mistakenly connecting to the user's
// real DB. Tests must declare their intent by setting PINLOOM_TEST_MODE=1,
// AND they must point PINLOOM_DB_PATH somewhere that isn't the default.
// If those don't agree, refuse to open the DB at all — better to crash
// the test run than silently destroy production data.
if (process.env.PINLOOM_TEST_MODE === '1') {
  if (!process.env.PINLOOM_DB_PATH || resolve(process.env.PINLOOM_DB_PATH) === DEFAULT_DB_PATH) {
    throw new Error(
      'PINLOOM_TEST_MODE=1 requires PINLOOM_DB_PATH to point at a non-default SQLite file. ' +
        `Got: ${process.env.PINLOOM_DB_PATH ?? '(unset)'} ` +
        '(refusing to run tests against the production DB).',
    );
  }
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}
