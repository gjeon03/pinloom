import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Feature-gating matrix E2E. Own SQLite file (fresh → first-run), own server,
// so it never touches the user's data. Mirrors playwright.config.ts.
const tempDb = path.join(os.tmpdir(), `pinloom-e2e-gating-${process.pid}-${Date.now()}.sqlite`);

if (!tempDb.startsWith(os.tmpdir())) {
  throw new Error(`E2E DB path must live under tmpdir; got ${tempDb}`);
}

export default defineConfig({
  testDir: '.',
  testMatch: /gating\.spec\.ts$/,
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
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PINLOOM_DB_PATH: tempDb,
      PINLOOM_TEST_MODE: '1',
    },
  },
});
