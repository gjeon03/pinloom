import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  USER_PROFILE_MAX,
  UserProfileError,
  buildUserProfileContext,
  getUserProfile,
  setUserProfile,
} from './user-profile.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-profile-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('user profile', () => {
  it('is empty when no file exists', () => {
    expect(getUserProfile(root)).toBe('');
    expect(buildUserProfileContext(root)).toBe('');
  });

  it('round-trips a saved profile', async () => {
    await setUserProfile('I prefer pnpm and conventional commits.', root);
    expect(getUserProfile(root)).toBe(
      'I prefer pnpm and conventional commits.',
    );
    const ctx = buildUserProfileContext(root);
    expect(ctx).toContain('About the user');
    expect(ctx).toContain('conventional commits');
  });

  it('rejects a non-string or over-cap profile', async () => {
    await expect(setUserProfile(42 as unknown, root)).rejects.toBeInstanceOf(
      UserProfileError,
    );
    await expect(
      setUserProfile('x'.repeat(USER_PROFILE_MAX + 1), root),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('truncates with a notice if the file is hand-edited past the cap', async () => {
    // write directly past the cap (bypassing the API guard)
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'USER.md'), 'y'.repeat(USER_PROFILE_MAX + 500));
    const ctx = buildUserProfileContext(root);
    expect(ctx).toContain('truncated to the first');
    // the inlined body (the longest consecutive run of y's) is capped
    const longestRun = Math.max(
      ...[...ctx.matchAll(/y+/g)].map((m) => m[0].length),
    );
    expect(longestRun).toBe(USER_PROFILE_MAX);
  });
});
