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
//   4. electron-rebuild better-sqlite3 + node-pty inside the staged copy for
//      Electron's ABI, then assert they actually load under Electron-as-node.
//
// Native-ABI notes (do NOT drop either from --only without re-checking):
//   • better-sqlite3 is NAN / V8-versioned ABI (NODE_MODULE_VERSION) — it MUST
//     be recompiled per ABI (Electron 33 = 130, Node 24 = 137). This is the one
//     that breaks loudly if skipped.
//   • node-pty is Node-API (ABI-stable across Node/Electron) — rebuilding it is
//     belt-and-suspenders, but it's cheap and keeps the staged build/Release
//     binary canonical.
//   • sqlite-vec is a loadable SQLite extension dylib (ABI-independent).
//   • onnxruntime-node (semantic search) is imported dynamically + degrade-safe,
//     so it can stay Node-ABI and falls back to lexical FTS under Electron.
//
// Run via `pnpm --filter @pinloom/desktop stage` (optionally `-- --no-build`).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STAGING, STAGED_BACKEND, STAGED_FRONTEND } = require('../staging-path.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '../../..');

const skipBuild = process.argv.includes('--no-build');

function run(cmd, args, cwd, env) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

// ── 1. build ────────────────────────────────────────────────────────────────
// Build the backend toolchain into the workspace as usual (the running prod
// process already holds its modules in memory, and these changes are env-gated
// no-ops, so an overwrite is inert). The FRONTEND, however, is built straight
// into the staging dir — NOT the workspace dist — so a developer's live
// `vite preview` keeps serving its existing build untouched (and no PWA
// auto-update fires on their open tab).
if (!skipBuild) {
  run('pnpm', ['--filter=@pinloom/shared', 'build'], REPO_ROOT);
  run('pnpm', ['--filter=@pinloom/mcp-server', 'build'], REPO_ROOT);
  run('pnpm', ['--filter=@pinloom/backend', 'build'], REPO_ROOT);
  run(
    'pnpm',
    ['--filter=@pinloom/frontend', 'exec', 'vite', 'build', '--outDir', STAGED_FRONTEND, '--emptyOutDir'],
    REPO_ROOT,
  );
}
if (!existsSync(join(REPO_ROOT, 'packages/backend/dist/server.js'))) {
  throw new Error('backend not built (packages/backend/dist/server.js missing) — run without --no-build');
}
if (!existsSync(join(STAGED_FRONTEND, 'index.html'))) {
  throw new Error(`frontend not staged (${STAGED_FRONTEND}/index.html missing) — run without --no-build`);
}

// ── 2. deploy backend into staging (dereferenced real-file tree) ─────────────
// package-import-method=copy forces REAL copies (no hardlinks back to the global
// pnpm store), so the electron-rebuild below physically cannot touch the shared
// native modules the developer's running Node backend loads.
console.log('\n=== staging backend (pnpm deploy, copy mode) ===');
// --legacy: pnpm v10 otherwise refuses to deploy a workspace that isn't using
// injected dependencies. The legacy path copies workspace deps (incl. our
// @pinloom/shared + @pinloom/mcp-server) into the deploy node_modules.
run(
  'pnpm',
  ['--filter=@pinloom/backend', '--prod', '--legacy', 'deploy', STAGED_BACKEND],
  REPO_ROOT,
  { npm_config_package_import_method: 'copy' },
);
if (!existsSync(join(STAGED_BACKEND, 'dist/server.js'))) {
  throw new Error(`deploy produced no dist/server.js at ${STAGED_BACKEND}`);
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

// ── 5. ABI tripwires ─────────────────────────────────────────────────────────
// (a) The staged native modules MUST load under Electron-as-node — this is the
//     ground-truth check that the rebuild produced the right ABI (a silent
//     wrong-ABI binary is exactly the failure that bricks the .dmg).
console.log('\n=== verify staged modules load under Electron-as-node ===');
const electronBin = join(DESKTOP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
execFileSync(
  electronBin,
  ['-e', "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); require('node-pty'); console.log('staged better-sqlite3 + node-pty OK under Electron');"],
  { cwd: STAGED_BACKEND, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
);

// (b) The developer's workspace better-sqlite3 MUST still load under plain Node
//     — if a stray rebuild ever flipped the shared store to Electron's ABI, the
//     running prod backend would crash on its next restart. Fail the build loud.
console.log('=== verify workspace better-sqlite3 still Node-ABI ===');
execFileSync(
  process.execPath,
  ['-e', "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('workspace better-sqlite3 still Node-ABI OK');"],
  { cwd: join(REPO_ROOT, 'packages/backend'), stdio: 'inherit' },
);

console.log('\n✅ staged:');
console.log(`   ${STAGED_BACKEND}`);
console.log(`   ${STAGED_FRONTEND}`);
