import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

  it('readCheckpoint returns the last UUID, complete EOF, identity, and meaningful type', () => {
    const file = writeSession('s2', [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a9' },
      { type: 'user', uuid: 'sidechain', isSidechain: true },
      { type: 'user', uuid: 'synthetic', message: { model: '<synthetic>' } },
    ]);
    appendFileSync(file, '\n{incomplete');
    expect(readCheckpoint(file)).toEqual({
      uuid: 'synthetic',
      completeOffset: Buffer.byteLength(readFileSync(file, 'utf8')) - Buffer.byteLength('{incomplete'),
      transcriptIdentity: expect.stringMatching(/^\d+:\d+$/),
      lastConversationType: 'assistant',
    });
    expect(readCheckpoint(path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('readCheckpoint returns a zero checkpoint for a readable empty transcript', () => {
    const file = path.join(dir, 'empty.jsonl');
    writeFileSync(file, '');

    expect(readCheckpoint(file)).toEqual({
      uuid: null,
      completeOffset: 0,
      transcriptIdentity: expect.stringMatching(/^\d+:\d+$/),
      lastConversationType: null,
    });
  });

  it('readCheckpoint scans complete records from the end across a one MiB boundary', () => {
    const straddled = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: { content: 'x'.repeat(1 << 20) },
    });
    const largeFile = path.join(dir, 'large.jsonl');
    writeFileSync(largeFile, `${straddled}\n{partial`);

    expect(readCheckpoint(largeFile)).toMatchObject({
      uuid: 'a1',
      completeOffset: Buffer.byteLength(`${straddled}\n`),
      lastConversationType: 'assistant',
    });
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
