import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

// Point the lazy DB singleton at a per-process temp file BEFORE any module
// (transitively) imports `db/connection.ts` and freezes its DB_PATH constant.
const dbPath = path.join(
  os.tmpdir(),
  `pinloom-test-${process.pid}-${Date.now()}.sqlite`,
);
process.env.PINLOOM_DB_PATH = dbPath;
// Declare test intent so connection.ts's startup guard can verify the path
// is non-default and refuse to run against production data.
process.env.PINLOOM_TEST_MODE = '1';

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // best effort
    }
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
