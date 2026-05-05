import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Each E2E run gets its own SQLite file so it physically cannot touch the
// user's real data/pinloom.sqlite. Date.now() per-process keeps reruns clean.
const tempDb = path.join(os.tmpdir(), `pinloom-e2e-${process.pid}-${Date.now()}.sqlite`);

// Loud sanity check — refuse to run if anything looks wrong with the
// isolation. The previous version of this file had a quiet failure mode
// (reuseExistingServer ignored env overrides and reused the user's running
// dev server, deleting production data).
if (!tempDb.startsWith(os.tmpdir())) {
  throw new Error(`E2E DB path must live under tmpdir; got ${tempDb}`);
}

export default defineConfig({
  testDir: '.',
  // The smoke test mutates shared backend state; serialize.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4747',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    cwd: '..',
    url: 'http://localhost:4747',
    timeout: 120_000,
    // Always start a fresh backend+frontend. A previously-running dev
    // server (using the real DB) must NEVER be reused — that's how the
    // beforeEach DELETE in tests can wipe real data.
    // If the port is already in use, fail loudly: stop your dev server,
    // then re-run.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PINLOOM_DB_PATH: tempDb,
      // Backend (db/connection.ts) refuses to start if this is set but
      // PINLOOM_DB_PATH points at the default production path.
      PINLOOM_TEST_MODE: '1',
    },
  },
});
