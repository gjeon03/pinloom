import { describe, it, expect } from 'vitest';
import { cleanChildEnv } from './child-env.js';

describe('cleanChildEnv', () => {
  it('strips PORT so spawned dev servers (next/vite) use their own default', () => {
    const prev = process.env.PORT;
    process.env.PORT = '4788';
    try {
      expect(cleanChildEnv().PORT).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PORT;
      else process.env.PORT = prev;
    }
  });

  it('strips pinloom server-runtime vars (PINLOOM_DB_PATH / TEST_MODE / static)', () => {
    // The test runner sets these — they must NOT leak into user shells.
    const env = cleanChildEnv();
    expect(env.PINLOOM_DB_PATH).toBeUndefined();
    expect(env.PINLOOM_TEST_MODE).toBeUndefined();
    expect(env.PINLOOM_SERVE_STATIC).toBeUndefined();
    expect(env.PINLOOM_STATIC_DIR).toBeUndefined();
  });

  it('preserves ordinary env (PATH, HOME) so the shell still works', () => {
    const env = cleanChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
