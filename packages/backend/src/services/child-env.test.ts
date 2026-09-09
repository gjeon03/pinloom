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

  it('strips Claude Code runtime markers so a spawned claude is not a nested child', () => {
    // Inherited CLAUDE_CODE_CHILD_SESSION makes the spawned claude turn OFF
    // transcript saving — and with no transcript, capture writes nothing to
    // SQLite. Happens whenever pinloom is started from inside a Claude Code
    // session (macOS `open` propagates the caller's env to the app).
    const MARKERS = {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/somewhere/claude',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
      CLAUDE_PID: '1234',
      CLAUDE_PLUGIN_DATA: '/plugins/data',
      CLAUDE_PLUGIN_ROOT: '/plugins',
      CLAUDE_EFFORT: 'max',
    };
    const saved = Object.keys(MARKERS).map((k) => [k, process.env[k]] as const);
    try {
      for (const [k, v] of Object.entries(MARKERS)) process.env[k] = v;
      const env = cleanChildEnv();
      for (const k of Object.keys(MARKERS)) expect(env[k]).toBeUndefined();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('keeps the user\'s own claude configuration (only runtime markers go)', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/Users/me/.claude';
    try {
      expect(cleanChildEnv().CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it('preserves ordinary env (PATH, HOME) so the shell still works', () => {
    const env = cleanChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
