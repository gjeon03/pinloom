// Atomic local deploy: build the dmg, then reinstall + relaunch the app — all
// SYNCHRONOUSLY, in order. The recurring footgun was kicking off the build in
// the background and reinstalling before it finished (installing a stale dmg).
// execSync here makes each step block, so "deploy done" means the running app
// is the freshly built one. macOS-only (hdiutil/open); a no-op elsewhere.
//
// Run with:  pnpm --filter @pinloom/desktop run deploy:app
// (named `deploy:app`, not `deploy`, because `pnpm deploy` is a pnpm built-in
// that would otherwise shadow the script.)
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const DMG = path.join(desktop, 'dist-app', 'pinloom-0.0.1-arm64.dmg');
const APP_ID = 'io.pinloom.desktop';
const MOUNT = '/tmp/pinloom-deploy-mnt';

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}
function quiet(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

if (process.platform !== 'darwin') {
  console.error('deploy: macOS only (uses hdiutil/open). Skipping.');
  process.exit(0);
}

console.log('▶ building dmg (stage + electron-builder)…');
run('pnpm run dmg', { cwd: desktop, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });

if (!existsSync(DMG)) {
  console.error(`deploy: dmg not found at ${DMG} after build — aborting.`);
  process.exit(1);
}

console.log('▶ quitting running app…');
quiet(`osascript -e 'tell application id "${APP_ID}" to quit'`);
// give it a moment to release the bundle
run('sleep 2');

console.log('▶ installing to /Applications…');
quiet(`hdiutil detach "${MOUNT}" -force`); // clean any stale mount
run(`mkdir -p "${MOUNT}"`);
run(`hdiutil attach "${DMG}" -nobrowse -noverify -mountpoint "${MOUNT}"`);
try {
  run('rm -rf /Applications/pinloom.app');
  run(`cp -R "${MOUNT}/pinloom.app" /Applications/pinloom.app`);
} finally {
  quiet(`hdiutil detach "${MOUNT}" -force`);
  quiet(`rmdir "${MOUNT}"`);
}
quiet('xattr -dr com.apple.quarantine /Applications/pinloom.app');

console.log('▶ relaunching…');
// macOS `open` hands the caller's environment to the app. Deploying from inside
// a Claude Code session therefore leaked that session's runtime markers into the
// app — and from there into every agent pty pinloom spawns, where an inherited
// CLAUDE_CODE_CHILD_SESSION turns the spawned claude's transcript saving OFF and
// silently stops history capture. cleanChildEnv now strips these too, but scrub
// them here as well so the app process itself never carries them.
const CLAUDE_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_EFFORT',
];
run(`env ${CLAUDE_MARKERS.map((k) => `-u ${k}`).join(' ')} open /Applications/pinloom.app`);
console.log('✓ deploy complete — running app is the freshly built bundle.');
