import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  distillDay,
  gitCommitsForDay,
  parseGitLog,
  type RunDistill,
} from './distill.js';

describe('parseGitLog', () => {
  it('parses tab-separated hash/date/subject (subject may contain tabs)', () => {
    const out = 'abc123\t2026-06-24 10:00:00\tfeat: add thing\ndef456\t2026-06-24 11:00:00\tfix: a\tb';
    expect(parseGitLog(out)).toEqual([
      { hash: 'abc123', date: '2026-06-24 10:00:00', subject: 'feat: add thing' },
      { hash: 'def456', date: '2026-06-24 11:00:00', subject: 'fix: a\tb' },
    ]);
  });
  it('returns [] for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('gitCommitsForDay', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pinloom-nogit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] for a non-git directory (no throw)', async () => {
    await expect(gitCommitsForDay(dir, '2026-06-24')).resolves.toEqual([]);
  });

  it('does not throw on the real repo and returns an array', async () => {
    const repo = path.resolve(process.cwd(), '..', '..');
    const commits = await gitCommitsForDay(repo, '2026-06-24');
    expect(Array.isArray(commits)).toBe(true);
  });
});

describe('distillDay', () => {
  it('feeds commits/sessions/existing entry to the model and returns its markdown', async () => {
    let seenPrompt = '';
    const fake: RunDistill = async (prompt) => {
      seenPrompt = prompt;
      return '# 2026-06-24 — Demo\n\n## 한 일\n- did stuff';
    };
    const md = await distillDay(
      {
        projectName: 'Demo',
        date: '2026-06-24',
        sessions: [{ id: 's1', title: 'work', transcript: '[user] build the thing' }],
        commits: [{ hash: 'abc123', date: 'd', subject: 'feat: thing' }],
        existingEntry: '# 2026-06-24 — Demo\n\n## 한 일\n- earlier work',
      },
      { runDistill: fake },
    );
    expect(seenPrompt).toContain('Demo');
    expect(seenPrompt).toContain('abc123 feat: thing');
    expect(seenPrompt).toContain('[user] build the thing');
    expect(seenPrompt).toContain('earlier work'); // existing entry passed for incremental update
    expect(md).toContain('did stuff');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('returns empty string when the model yields nothing', async () => {
    const md = await distillDay(
      { projectName: 'D', date: '2026-06-24', sessions: [], commits: [], existingEntry: null },
      { runDistill: async () => '   ' },
    );
    expect(md).toBe('');
  });
});
