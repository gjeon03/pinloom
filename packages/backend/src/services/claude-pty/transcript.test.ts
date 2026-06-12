import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  projectSlug,
  projectDir,
  sessionFilePath,
  sessionIdOf,
  listSessionFiles,
  discoverNewSessionFile,
  readLines,
  readCheckpoint,
} from './transcript.js';

describe('projectSlug', () => {
  it('replaces every non-alphanumeric run char with a dash (matches real dirs)', () => {
    expect(projectSlug('/Users/x/Documents_LOCAL/pinloom')).toBe(
      '-Users-x-Documents-LOCAL-pinloom',
    );
    // a leading dot dir produces the observed double dash
    expect(projectSlug('/Users/x/.pinloom/wiki')).toBe('-Users-x--pinloom-wiki');
  });
});

describe('sessionIdOf / sessionFilePath', () => {
  it('round-trips a session id through the file path', () => {
    const file = sessionFilePath('/p', 'abc-123', '/home');
    expect(file).toBe(path.join('/home', '.claude', 'projects', '-p', 'abc-123.jsonl'));
    expect(sessionIdOf(file)).toBe('abc-123');
  });
});

describe('transcript fs helpers', () => {
  let home: string;
  let cwd: string;
  let dir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'pinloom-home-'));
    cwd = '/Users/test/proj';
    dir = projectDir(cwd, home);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeSession(id: string, lines: object[]): string {
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    return file;
  }

  it('lists session files and reads/parses lines', () => {
    const file = writeSession('s1', [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
    ]);
    expect(listSessionFiles(cwd, home)).toEqual(new Set([file]));
    expect(readLines(file).map((l) => l.uuid)).toEqual(['u1', 'a1']);
  });

  it('readCheckpoint returns the last uuid, null for missing/empty', () => {
    const file = writeSession('s2', [
      { type: 'user', uuid: 'u1' },
      { type: 'file-history-snapshot' }, // no uuid → skipped
      { type: 'assistant', uuid: 'a9' },
      { type: 'ai-title' }, // trailing, no uuid → skipped
    ]);
    expect(readCheckpoint(file)).toBe('a9');
    expect(readCheckpoint(path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('discoverNewSessionFile finds the file not present before', async () => {
    const before = listSessionFiles(cwd, home);
    const created = writeSession('fresh', [{ type: 'user', uuid: 'u1' }]);
    const found = await discoverNewSessionFile(cwd, before, { home, timeoutMs: 1000 });
    expect(found).toBe(created);
  });

  it('discoverNewSessionFile throws when >1 new transcript appears (ambiguous)', async () => {
    const before = listSessionFiles(cwd, home);
    writeSession('one', [{ type: 'user', uuid: 'u1' }]);
    writeSession('two', [{ type: 'user', uuid: 'u2' }]);
    await expect(
      discoverNewSessionFile(cwd, before, { home, timeoutMs: 1000 }),
    ).rejects.toThrow(/ambiguous/);
  });

  it('discoverNewSessionFile throws on timeout when nothing new appears', async () => {
    const before = listSessionFiles(cwd, home);
    await expect(
      discoverNewSessionFile(cwd, before, { home, timeoutMs: 120, pollMs: 30 }),
    ).rejects.toThrow(/did not appear/);
  });
});
