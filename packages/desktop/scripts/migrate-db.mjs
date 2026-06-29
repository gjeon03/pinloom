// One-time, NON-DESTRUCTIVE migration of an existing pinloom database into the
// app's canonical location (~/.pinloom/data/pinloom.sqlite).
//
// Use this when moving from the launchd-served setup (DB at <repo>/data/
// pinloom.sqlite) to the resident desktop app, which reads ~/.pinloom/data.
//
//   node packages/desktop/scripts/migrate-db.mjs                 # repo DB → canonical
//   node packages/desktop/scripts/migrate-db.mjs --source <path> --target <path>
//   node packages/desktop/scripts/migrate-db.mjs --force         # overwrite target (backs it up first)
//
// Safety:
//   • SOURCE is only ever READ (better-sqlite3 online .backup() — a consistent
//     snapshot even if the source has an active WAL / is open elsewhere).
//   • TARGET is never silently clobbered: refused if it exists, unless --force,
//     which first copies it aside to <target>.bak-<timestamp>.
//   • The copy is verified (row counts of key tables match) before reporting OK.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
// better-sqlite3 lives in the backend package, not desktop — resolve from there.
const requireFromBackend = createRequire(join(REPO_ROOT, 'packages/backend/package.json'));
const Database = requireFromBackend('better-sqlite3');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const force = process.argv.includes('--force');
const SOURCE = resolve(arg('source', join(REPO_ROOT, 'data/pinloom.sqlite')));
const TARGET = resolve(arg('target', join(homedir(), '.pinloom', 'data', 'pinloom.sqlite')));

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(SOURCE)) fail(`source DB not found: ${SOURCE}`);
if (resolve(SOURCE) === resolve(TARGET)) fail('source and target are the same file');

// Validate the source is a real pinloom DB before touching anything.
let srcCounts;
try {
  const src = new Database(SOURCE, { readonly: true, fileMustExist: true });
  const has = (t) =>
    src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null;
  if (!has('sessions') || !has('projects')) {
    src.close();
    fail(`${SOURCE} doesn't look like a pinloom DB (no sessions/projects tables)`);
  }
  srcCounts = {
    sessions: src.prepare('SELECT count(*) c FROM sessions').get().c,
    projects: src.prepare('SELECT count(*) c FROM projects').get().c,
    messages: src.prepare('SELECT count(*) c FROM messages').get().c,
  };
  src.close();
} catch (e) {
  fail(`cannot open source DB: ${e.message}`);
}

console.log(`source: ${SOURCE}`);
console.log(`  ${srcCounts.sessions} sessions · ${srcCounts.projects} projects · ${srcCounts.messages} messages`);
console.log(`target: ${TARGET}`);

if (existsSync(TARGET)) {
  if (!force) {
    fail(`target already exists. Re-run with --force to overwrite (it will be backed up first).`);
  }
  const bak = `${TARGET}.bak-${Date.now()}`;
  copyFileSync(TARGET, bak);
  console.log(`⚠ target existed — backed up to ${bak}`);
}

mkdirSync(dirname(TARGET), { recursive: true });

// Online backup: a transactionally-consistent snapshot, WAL included, without
// requiring the source to be closed.
const src = new Database(SOURCE, { readonly: true, fileMustExist: true });
await src.backup(TARGET);
src.close();

// Verify the copy.
const dst = new Database(TARGET, { readonly: true, fileMustExist: true });
const dstCounts = {
  sessions: dst.prepare('SELECT count(*) c FROM sessions').get().c,
  projects: dst.prepare('SELECT count(*) c FROM projects').get().c,
  messages: dst.prepare('SELECT count(*) c FROM messages').get().c,
};
const integrity = dst.prepare('PRAGMA integrity_check').get();
dst.close();

const ok =
  dstCounts.sessions === srcCounts.sessions &&
  dstCounts.projects === srcCounts.projects &&
  dstCounts.messages === srcCounts.messages &&
  (integrity.integrity_check === 'ok' || integrity['integrity_check'] === 'ok');

if (!ok) {
  fail(
    `verification FAILED — copied (${dstCounts.sessions}/${dstCounts.projects}/${dstCounts.messages}) ` +
      `vs source (${srcCounts.sessions}/${srcCounts.projects}/${srcCounts.messages}), integrity=${JSON.stringify(integrity)}. ` +
      `The source DB is untouched.`,
  );
}

console.log(`✓ migrated and verified — ${TARGET}`);
console.log('  The source DB was not modified. You can now point the app here and stop the launchd server.');
