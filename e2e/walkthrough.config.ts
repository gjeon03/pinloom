import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Same isolation contract as playwright.config.ts: throwaway SQLite under
// tmpdir, refuse to start if anything looks off. The walkthrough variant
// is a separate config so it can record video, pin a 1440x900 viewport
// for clean Reddit screenshots, and relocate $HOME so screenshots never
// leak the developer's real username via the ~/.pinloom/wiki path shown
// in the Wiki page header.
//
// Playwright loads this config in BOTH the runner process and the worker
// process. Computing the path with Date.now() each load yields different
// values, so we memoize via env: the runner computes once and writes the
// path back to process.env; the worker re-imports the config, finds the
// env var already set, and reuses it. Otherwise the spec writes seed
// data under a path the backend never reads from.
const stamp = `${process.pid}-${Date.now()}`;
const tempDb =
  process.env.PINLOOM_WALKTHROUGH_DB ??
  path.join(os.tmpdir(), `pinloom-walkthrough-${stamp}.sqlite`);
const tempHome =
  process.env.PINLOOM_WALKTHROUGH_HOME ??
  path.join(os.tmpdir(), `pinloom-walkthrough-home-${stamp}`);
process.env.PINLOOM_WALKTHROUGH_DB = tempDb;
process.env.PINLOOM_WALKTHROUGH_HOME = tempHome;
if (!tempDb.startsWith(os.tmpdir())) {
  throw new Error(`walkthrough DB path must live under tmpdir; got ${tempDb}`);
}
if (!tempHome.startsWith(os.tmpdir())) {
  throw new Error(`walkthrough HOME path must live under tmpdir; got ${tempHome}`);
}

// Pre-create the temp HOME so the backend's os.homedir() resolves cleanly
// and the spec can seed wiki content into ~/.pinloom/wiki before the test
// navigates there.
mkdirSync(path.join(tempHome, '.pinloom', 'wiki', 'pages'), { recursive: true });

// Symlink the real ~/.claude (auth + config) into the temp HOME so the
// Claude Agent SDK can still authenticate when sending a real prompt
// during the walkthrough. Without this, overriding HOME breaks SDK auth.
// We symlink the directory rather than copying so token rotations on the
// host stay in sync with the test for the rare case the walkthrough is
// re-run later.
const realHome = process.env.PINLOOM_REAL_HOME ?? os.homedir();
const realClaude = path.join(realHome, '.claude');
const tempClaude = path.join(tempHome, '.claude');
if (existsSync(realClaude) && !existsSync(tempClaude)) {
  symlinkSync(realClaude, tempClaude, 'dir');
}

// Pre-fetch the Claude reply that the spec will pin in the workspace
// screenshot. Doing this here (in the main playwright process, before
// any worker spawns) means the per-test video recording starts AFTER
// the slow CLI call finishes — otherwise the first ~10 seconds of the
// recorded video would be a blank tab waiting on the prompt to return.
// Memoize via env so each worker re-import reuses the same answer.
const CLAUDE_CLI =
  process.env.PINLOOM_WALKTHROUGH_CLAUDE_CLI ?? '/home/gyeongyeon/.local/bin/claude';
const WALKTHROUGH_PROMPT =
  process.env.PINLOOM_WALKTHROUGH_PROMPT ??
  "Quick design call: for the pinloom-demo reading-list CLI (single user, single machine), should the persistence layer use writeFileSync or fs.promises.writeFile? Answer in English, 2-3 sentences, with the reasoning. No code.";
if (!process.env.PINLOOM_WALKTHROUGH_CLAUDE_REPLY) {
  const r = spawnSync(CLAUDE_CLI, ['-p', WALKTHROUGH_PROMPT], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `Walkthrough setup: claude -p failed (${r.status}): ${
        r.stderr || r.stdout
      }`,
    );
  }
  const reply = r.stdout.trim();
  if (!reply) throw new Error('Walkthrough setup: claude returned empty output');
  process.env.PINLOOM_WALKTHROUGH_CLAUDE_REPLY = reply;
}
process.env.PINLOOM_WALKTHROUGH_PROMPT = WALKTHROUGH_PROMPT;

// Expose the temp HOME to the spec process so it can seed wiki pages on
// disk before the page navigates. Playwright workers inherit env from the
// parent process where this config runs.
process.env.PINLOOM_WALKTHROUGH_HOME = tempHome;

export default defineConfig({
  testDir: '.',
  testMatch: /walkthrough\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'artifacts/playwright-output',
  use: {
    baseURL: 'http://localhost:4747',
    viewport: { width: 1440, height: 900 },
    trace: 'on',
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    screenshot: 'on',
    colorScheme: 'dark',
    // slowMo makes each Playwright action pause briefly so the recorded
    // video reads as a deliberate human walkthrough rather than a 5s
    // robotic blur. Trade-off: total runtime climbs (~30s instead of
    // ~5s) but the .webm is actually watchable on Reddit.
    launchOptions: { slowMo: 600 },
  },
  webServer: {
    command: 'pnpm dev',
    cwd: '..',
    url: 'http://localhost:4747',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PINLOOM_DB_PATH: tempDb,
      PINLOOM_TEST_MODE: '1',
      // Backend uses os.homedir() to resolve ~/.pinloom/wiki. Overriding
      // HOME redirects that to a path under $TMPDIR, so screenshots
      // (specifically the Wiki page header) never expose the developer's
      // real username.
      HOME: tempHome,
    },
  },
});
