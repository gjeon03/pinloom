import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAnalysisCwd } from './wiki-analyzer.js';

// Verifies the #C fix: conventions analysis reads the DEFAULT branch, not the
// currently checked-out (possibly unmerged) feature branch.

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('resolveAnalysisCwd', () => {
  it('falls back to the cwd for a non-git directory (cleanup is a no-op)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pinloom-nogit-'));
    cleanups.push(dir);
    const r = await resolveAnalysisCwd(dir);
    expect(r.cwd).toBe(dir);
    await r.cleanup(); // must not throw
    expect(existsSync(dir)).toBe(true);
  });

  it('analyzes the default branch even when a feature branch is checked out', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'pinloom-repo-'));
    cleanups.push(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(path.join(repo, 'marker.txt'), 'MAIN', 'utf8');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'main');
    // feature branch with a different marker, left checked out + uncommitted noise
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(path.join(repo, 'marker.txt'), 'FEATURE', 'utf8');
    git(repo, 'commit', '-am', 'feature');
    writeFileSync(path.join(repo, 'marker.txt'), 'UNCOMMITTED', 'utf8'); // dirty working tree

    const r = await resolveAnalysisCwd(repo);
    expect(r.cwd).not.toBe(repo); // a worktree, not the live cwd
    // the worktree reflects main's committed state, not the feature branch or the dirty file
    expect(readFileSync(path.join(r.cwd, 'marker.txt'), 'utf8').trim()).toBe('MAIN');

    await r.cleanup();
    expect(existsSync(r.cwd)).toBe(false); // worktree removed
  });
});
