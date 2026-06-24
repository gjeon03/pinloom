import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './migrations.js';

const requireFromHere = createRequire(import.meta.url);

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

// Whether the sqlite-vec extension loaded successfully on the live connection.
// Semantic search / vector indexing are gated on this; when false everything
// degrades to lexical FTS (the extension is OPTIONAL — a missing/incompatible
// native dylib must NEVER stop the backend from booting). Loaded once on the
// single shared connection, so it persists for the app's life.
let vectorExtensionLoaded = false;

export function isVectorAvailable(): boolean {
  return vectorExtensionLoaded;
}

// Best-effort load of sqlite-vec onto the connection. Isolated in try/catch:
// any failure (missing prebuilt, ABI mismatch, sandbox) leaves the flag false
// and the app fully functional on FTS.
function loadVectorExtension(database: Database.Database): void {
  try {
    // Lazy require so a broken native dep can't crash module import either.
    const sqliteVec = requireFromHere('sqlite-vec') as { getLoadablePath(): string };
    database.loadExtension(sqliteVec.getLoadablePath());
    vectorExtensionLoaded = true;
  } catch (err) {
    vectorExtensionLoaded = false;
    // eslint-disable-next-line no-console
    console.error(
      '[vector] sqlite-vec unavailable — search stays lexical-only:',
      err instanceof Error ? err.message : err,
    );
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  // After migrations so the ledger is never blocked by the optional extension.
  loadVectorExtension(db);
  return db;
}
