import { defineConfig } from '@playwright/test';

// Runs against an ALREADY-RUNNING isolated instance (backend 6748 / frontend
// 6751, both on a temp test DB) started by hand — so it never touches the
// user's production server on 4747/4748. No webServer block on purpose.
export default defineConfig({
  testDir: '.',
  testMatch: /(inprogress|pwa-update)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:6751',
    trace: 'retain-on-failure',
  },
});
