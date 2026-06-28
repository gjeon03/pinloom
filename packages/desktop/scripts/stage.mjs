// Stage a self-contained app payload for electron-builder, WITHOUT ever
// touching the workspace's shared node_modules (rebuilding those for Electron's
// ABI would crash the developer's running Node backend on its next restart).
//
// Flow:
//   1. build all workspace packages (shared → mcp-server → backend → frontend)
//   2. `pnpm deploy` the backend into staging/app-backend — a real-file tree
//      (workspace deps dereferenced, prod deps only). This is a COPY, so the
//      next step never reaches back into the shared store.
//   3. copy the built frontend into staging/app-frontend (static serving)
//   4. electron-rebuild ONLY better-sqlite3 + node-pty inside the staged copy
//      for Electron's ABI. (onnxruntime-node is loaded dynamically + degrade-
//      safe, so it can stay Node-ABI; sqlite-vec is a SQLite extension dylib,
//      ABI-independent.)
//
// Run via `pnpm --filter @pinloom/desktop stage` (optionally `-- --no-build`).
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '../../..');
const STAGING = join(DESKTOP_DIR, 'staging');
const STAGED_BACKEND = join(STAGING, 'app-backend');
const STAGED_FRONTEND = join(STAGING, 'app-frontend');

const skipBuild = process.argv.includes('--no-build');

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

// ── 1. build ────────────────────────────────────────────────────────────────
if (!skipBuild) {
  run('pnpm', ['build'], REPO_ROOT);
}
if (!existsSync(join(REPO_ROOT, 'packages/backend/dist/server.js'))) {
  throw new Error('backend not built (packages/backend/dist/server.js missing) — run without --no-build');
}
if (!existsSync(join(REPO_ROOT, 'packages/frontend/dist/index.html'))) {
  throw new Error('frontend not built (packages/frontend/dist/index.html missing)');
}

// ── 2. deploy backend into staging (dereferenced real-file tree) ─────────────
console.log('\n=== staging backend (pnpm deploy) ===');
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
run('pnpm', ['--filter=@pinloom/backend', '--prod', 'deploy', STAGED_BACKEND], REPO_ROOT);
if (!existsSync(join(STAGED_BACKEND, 'dist/server.js'))) {
  throw new Error(`deploy produced no dist/server.js at ${STAGED_BACKEND}`);
}

// ── 3. copy frontend static ──────────────────────────────────────────────────
console.log('\n=== staging frontend (static) ===');
cpSync(join(REPO_ROOT, 'packages/frontend/dist'), STAGED_FRONTEND, { recursive: true });
if (!existsSync(join(STAGED_FRONTEND, 'index.html'))) {
  throw new Error('frontend stage missing index.html');
}

// ── 4. electron-rebuild native addons in the staged copy ─────────────────────
console.log('\n=== electron-rebuild (better-sqlite3, node-pty) ===');
const electronPkg = JSON.parse(
  readFileSync(join(DESKTOP_DIR, 'node_modules/electron/package.json'), 'utf8'),
);
const electronVersion = electronPkg.version;
console.log(`electron version: ${electronVersion}`);
const rebuildBin = join(DESKTOP_DIR, 'node_modules/.bin/electron-rebuild');
run(
  rebuildBin,
  [
    '--version', electronVersion,
    '--module-dir', STAGED_BACKEND,
    '--only', 'better-sqlite3,node-pty',
  ],
  STAGED_BACKEND,
);

console.log('\n✅ staged:');
console.log(`   ${STAGED_BACKEND}`);
console.log(`   ${STAGED_FRONTEND}`);
