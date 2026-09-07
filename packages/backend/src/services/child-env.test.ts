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

  describe('UTF-8 locale default', () => {
    const LOCALE_VARS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;

    function withLocale(
      overrides: Partial<Record<(typeof LOCALE_VARS)[number], string>>,
      run: () => void,
    ) {
      const saved = LOCALE_VARS.map((k) => [k, process.env[k]] as const);
      try {
        for (const k of LOCALE_VARS) delete process.env[k];
        for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
        run();
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it('supplies one when the parent has none (GUI launch has no locale at all)', () => {
      // Without this, `pbcopy` — which Claude Code shells out to for its copy
      // action — reads UTF-8 stdin as MacRoman and mangles CJK on the pasteboard.
      withLocale({}, () => {
        expect(cleanChildEnv().LANG).toBe('en_US.UTF-8');
      });
    });

    it.each(LOCALE_VARS)('never overrides an explicit %s', (name) => {
      withLocale({ [name]: name === 'LC_CTYPE' ? 'UTF-8' : 'ko_KR.UTF-8' }, () => {
        const env = cleanChildEnv();
        expect(env[name]).toBe(name === 'LC_CTYPE' ? 'UTF-8' : 'ko_KR.UTF-8');
        if (name !== 'LANG') expect(env.LANG).toBeUndefined();
      });
    });
  });

  it('preserves ordinary env (PATH, HOME) so the shell still works', () => {
    const env = cleanChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
