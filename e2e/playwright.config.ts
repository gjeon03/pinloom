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
  // Walkthrough has its own config with HOME override + video recording.
  // Running it under the smoke config (which doesn't set HOME) leaves
  // wiki-related assertions failing because the wiki path is real.
  testMatch: /smoke\.spec\.ts$/,
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
  webServer: [
    {
      command: 'pnpm predev && pnpm --filter @pinloom/backend dev',
      cwd: '..',
      url: 'http://127.0.0.1:4748/api/projects',
      timeout: 120_000,
      // Always start a fresh backend. A previously-running server using the
      // real DB must never be reused by a destructive isolated E2E fixture.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: '4748',
        PINLOOM_DB_PATH: tempDb,
        // db/connection.ts rejects test mode with the production DB path.
        PINLOOM_TEST_MODE: '1',
      },
    },
    {
      command: 'pnpm --filter @pinloom/frontend exec vite --port 4747 --strictPort --host 127.0.0.1',
      cwd: '..',
      url: 'http://127.0.0.1:4747',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PORT: '4748' },
    },
  ],
});
