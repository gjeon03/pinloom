import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TimelineError,
  assertDate,
  assertSlug,
  globalDateView,
  listDates,
  listSlugs,
  readEntry,
  writeEntry,
} from './store.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pinloom-timeline-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('timeline path validation', () => {
  it('rejects traversal / bad slugs and dates', () => {
    for (const bad of ['../evil', 'a/b', 'a.b', 'UP', '', 'x'.repeat(101)]) {
      expect(() => assertSlug(bad)).toThrow(TimelineError);
    }
    for (const bad of ['2026-6-1', '2026/06/01', 'today', '20260601', '']) {
      expect(() => assertDate(bad)).toThrow(TimelineError);
    }
    expect(() => assertSlug('my-proj-a1b2c3')).not.toThrow();
    expect(() => assertDate('2026-06-24')).not.toThrow();
  });
});

describe('timeline store', () => {
  it('round-trips an entry', () => {
    expect(readEntry('proj', '2026-06-24', home)).toBeNull();
    writeEntry('proj', '2026-06-24', '# 2026-06-24\n\n작업 내용', home);
    expect(readEntry('proj', '2026-06-24', home)).toContain('작업 내용');
  });

  it('lists dates newest-first', () => {
    writeEntry('proj', '2026-06-22', 'a', home);
    writeEntry('proj', '2026-06-24', 'b', home);
    writeEntry('proj', '2026-06-23', 'c', home);
    expect(listDates('proj', home)).toEqual([
      '2026-06-24',
      '2026-06-23',
      '2026-06-22',
    ]);
  });

  it('lists slugs that have entries', () => {
    writeEntry('alpha', '2026-06-24', 'a', home);
    writeEntry('beta', '2026-06-24', 'b', home);
    expect(listSlugs(home)).toEqual(['alpha', 'beta']);
  });

  it('aggregates a global date view across projects', () => {
    writeEntry('alpha', '2026-06-24', 'alpha work', home);
    writeEntry('beta', '2026-06-24', 'beta work', home);
    writeEntry('alpha', '2026-06-23', 'old', home);
    const view = globalDateView('2026-06-24', home);
    expect(view.map((e) => e.slug)).toEqual(['alpha', 'beta']);
    expect(view.find((e) => e.slug === 'beta')?.markdown).toBe('beta work');
  });

  it('returns empty for unknown project/date', () => {
    expect(listDates('nope', home)).toEqual([]);
    expect(globalDateView('2026-06-24', home)).toEqual([]);
  });
});
