import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopLaunchEnv } from './launch-env.mjs';

test('does not pass deployment terminal color settings to the desktop app', () => {
  const source = {
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    CLICOLOR_FORCE: '0',
    TERM: 'dumb',
    COLORTERM: '',
    PATH: '/usr/bin',
    HOME: '/Users/example',
    CLAUDE_CONFIG_DIR: '/Users/example/.claude',
  };
  const original = { ...source };
  assert.deepEqual(createDesktopLaunchEnv(source), {
    PATH: source.PATH,
    HOME: source.HOME,
    CLAUDE_CONFIG_DIR: source.CLAUDE_CONFIG_DIR,
  });
  assert.deepEqual(source, original);
});

test('still isolates Claude session identity without changing user configuration', () => {
  assert.deepEqual(createDesktopLaunchEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
    CLAUDE_CONFIG_DIR: '/Users/example/.claude',
    LANG: 'ko_KR.UTF-8',
  }), {
    CLAUDE_CONFIG_DIR: '/Users/example/.claude',
    LANG: 'ko_KR.UTF-8',
  });
});
