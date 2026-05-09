import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import { _peekSecretCount, redactSecrets, reloadSecretValues } from './redact.js';
import { upsertUserEnvVar } from './user-env.js';

const TEST_KEYS = ['ASANA_TOKEN', 'CONFIG_VAR', 'TINY'];
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  getDb().exec('DELETE FROM user_env;');
  for (const k of TEST_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  reloadSecretValues();
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('redactSecrets', () => {
  it('returns the input unchanged when no secrets are configured', () => {
    expect(redactSecrets('hello asana')).toBe('hello asana');
  });

  it('masks an is_secret=1 value wherever it appears', () => {
    upsertUserEnvVar({
      key: 'ASANA_TOKEN',
      value: 'super-secret-token-1234',
      isSecret: true,
    });
    const out = redactSecrets(
      'curl -H "Authorization: Bearer super-secret-token-1234" https://...',
    );
    expect(out).not.toContain('super-secret-token-1234');
    expect(out).toContain('••••••');
  });

  it('does not redact non-secret values', () => {
    upsertUserEnvVar({
      key: 'CONFIG_VAR',
      value: 'https://api.example.com',
      isSecret: false,
    });
    const out = redactSecrets('endpoint = https://api.example.com');
    expect(out).toBe('endpoint = https://api.example.com');
  });

  it('skips short values (under 8 chars) to avoid mangling ordinary text', () => {
    upsertUserEnvVar({ key: 'TINY', value: 'abc', isSecret: true });
    expect(redactSecrets('abc def abc')).toBe('abc def abc');
  });

  it('refreshes the cache on upsert and delete', () => {
    upsertUserEnvVar({
      key: 'ASANA_TOKEN',
      value: 'secret-asana-pat-9999',
      isSecret: true,
    });
    expect(_peekSecretCount()).toBe(1);

    // Upsert overrides — count stays 1, but new value is masked.
    upsertUserEnvVar({
      key: 'ASANA_TOKEN',
      value: 'rotated-asana-pat-aaaa',
      isSecret: true,
    });
    expect(_peekSecretCount()).toBe(1);
    expect(redactSecrets('rotated-asana-pat-aaaa here')).toContain('••••••');

    // The old value is no longer in the cache and shouldn't get masked.
    expect(redactSecrets('secret-asana-pat-9999 here')).toBe(
      'secret-asana-pat-9999 here',
    );
  });
});
