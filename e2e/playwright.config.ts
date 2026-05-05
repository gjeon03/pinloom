import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Each E2E run gets its own SQLite file so a previous (or local-dev) DB
// can't bleed into the test. Date.now() per-process keeps reruns clean.
const tempDb = path.join(os.tmpdir(), `pinloom-e2e-${Date.now()}.sqlite`);

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
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PINLOOM_DB_PATH: tempDb,
    },
  },
});
