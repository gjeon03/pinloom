import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { botHomeDir } from './paths.js';
import { readScheduleConfig, resolveScheduleCwd } from './schedule.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-sched-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(json: string) {
  const dir = botHomeDir('schedule', home);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), json, 'utf8');
}

describe('readScheduleConfig', () => {
  it('returns null when no config exists', () => {
    expect(readScheduleConfig(home)).toBeNull();
  });

  it('parses a valid config', async () => {
    await writeConfig(
      JSON.stringify({ journalPath: '/vault/journal', format: 'hybrid' }),
    );
    expect(readScheduleConfig(home)).toEqual({
      journalPath: '/vault/journal',
      format: 'hybrid',
    });
  });

  it('rejects malformed / empty-path config', async () => {
    await writeConfig('{ not json');
    expect(readScheduleConfig(home)).toBeNull();
    await writeConfig(JSON.stringify({ journalPath: '' }));
    expect(readScheduleConfig(home)).toBeNull();
    await writeConfig(JSON.stringify({ foo: 'bar' }));
    expect(readScheduleConfig(home)).toBeNull();
  });
});

describe('resolveScheduleCwd', () => {
  it('falls back to the bot home when unconfigured, creating it so the spawn cwd exists', () => {
    const dir = botHomeDir('schedule', home);
    expect(existsSync(dir)).toBe(false);
    expect(resolveScheduleCwd(home)).toBe(dir);
    expect(existsSync(dir)).toBe(true); // must exist — it becomes the agent cwd
  });

  it('uses the journal path once it exists as a directory', async () => {
    const journal = path.join(home, 'vault', 'journal');
    await mkdir(journal, { recursive: true });
    await writeConfig(JSON.stringify({ journalPath: journal }));
    expect(resolveScheduleCwd(home)).toBe(journal);
  });

  it('falls back to home if the configured path does not exist', async () => {
    await writeConfig(JSON.stringify({ journalPath: '/no/such/dir/here' }));
    expect(resolveScheduleCwd(home)).toBe(botHomeDir('schedule', home));
  });
});
