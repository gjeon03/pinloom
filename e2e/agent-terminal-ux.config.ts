import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const frontendPort = 58747;
const backendPort = 58748;
const tempDb = path.join(
  os.tmpdir(),
  `pinloom-agent-terminal-ux-${process.pid}-${Date.now()}.sqlite`,
);

if (!tempDb.startsWith(os.tmpdir())) {
  throw new Error(`E2E DB path must live under tmpdir; got ${tempDb}`);
}

export default defineConfig({
  testDir: '.',
  testMatch: /agent-terminal-ux\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 960 },
  },
  webServer: [
    {
      command: 'pnpm predev && pnpm --filter @pinloom/backend dev',
      cwd: '..',
      url: `http://127.0.0.1:${backendPort}/api/projects`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(backendPort),
        PINLOOM_DB_PATH: tempDb,
        PINLOOM_TEST_MODE: '1',
        PINLOOM_CLAUDE_TRANSPORT: 'terminal',
      },
    },
    {
      command: `pnpm --filter @pinloom/frontend exec vite --port ${frontendPort} --strictPort --host 127.0.0.1`,
      cwd: '..',
      url: `http://127.0.0.1:${frontendPort}`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(backendPort),
      },
    },
  ],
});
