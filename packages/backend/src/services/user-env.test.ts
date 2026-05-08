import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import {
  isValidKey,
  loadUserEnvIntoProcess,
  upsertUserEnvVar,
} from './user-env.js';

const TEST_KEYS = ['ASANA_TOKEN', 'GITLAB_TOKEN'];
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  getDb().exec('DELETE FROM user_env;');
  for (const k of TEST_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('isValidKey', () => {
  it('accepts POSIX-style identifiers', () => {
    expect(isValidKey('ASANA_TOKEN')).toBe(true);
    expect(isValidKey('_X')).toBe(true);
    expect(isValidKey('foo123')).toBe(true);
  });

  it('rejects names with leading digits, spaces, or dashes', () => {
    expect(isValidKey('1FOO')).toBe(false);
    expect(isValidKey('FOO BAR')).toBe(false);
    expect(isValidKey('FOO-BAR')).toBe(false);
    expect(isValidKey('')).toBe(false);
  });
});

describe('loadUserEnvIntoProcess', () => {
  it('mirrors every stored row into process.env', () => {
    upsertUserEnvVar({ key: 'ASANA_TOKEN', value: 'asana-x' });
    upsertUserEnvVar({ key: 'GITLAB_TOKEN', value: 'gitlab-y' });

    // Simulate a fresh boot — clear, then call loadUserEnvIntoProcess.
    delete process.env.ASANA_TOKEN;
    delete process.env.GITLAB_TOKEN;

    loadUserEnvIntoProcess();
    expect(process.env.ASANA_TOKEN).toBe('asana-x');
    expect(process.env.GITLAB_TOKEN).toBe('gitlab-y');
  });

  it('overwrites pre-existing process.env values with the stored value', () => {
    process.env.ASANA_TOKEN = 'inherited-from-shell';
    upsertUserEnvVar({ key: 'ASANA_TOKEN', value: 'pinloom-managed' });

    delete process.env.ASANA_TOKEN;
    process.env.ASANA_TOKEN = 'shell-set-again';

    loadUserEnvIntoProcess();
    // pinloom's stored value wins over whatever the shell had inherited.
    expect(process.env.ASANA_TOKEN).toBe('pinloom-managed');
  });
});
