import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SkillError,
  assertSkillName,
  listSkills,
  saveSkill,
  type SkillRoots,
} from './skills.js';

let base: string;
let roots: SkillRoots;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'pinloom-skills-'));
  roots = {
    pinloom: path.join(base, 'pinloom', 'skills'),
    claude: path.join(base, 'claude', 'skills'),
    codex: path.join(base, 'codex', 'skills'),
  };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('assertSkillName', () => {
  it('accepts kebab slugs', () => {
    expect(() => assertSkillName('my-skill-1')).not.toThrow();
  });
  it('rejects traversal / uppercase / slashes / dots', () => {
    for (const bad of ['../evil', 'Up', 'a/b', 'a.b', '', '-leading', 'x'.repeat(65)]) {
      expect(() => assertSkillName(bad)).toThrow(SkillError);
    }
  });
});

describe('saveSkill (global)', () => {
  it('writes a canonical SKILL.md and symlinks into claude + codex', () => {
    const r = saveSkill(
      { name: 'commit-style', scope: 'global', description: 'Use when writing commits', body: 'Conventional commits.' },
      roots,
    );
    expect(r.action).toBe('created');
    expect(r.links).toEqual({ claude: 'linked', codex: 'linked' });
    const canonical = path.join(roots.pinloom, 'commit-style', 'SKILL.md');
    const md = readFileSync(canonical, 'utf8');
    expect(md).toContain('name: commit-style');
    expect(md).toContain('description: "Use when writing commits"');
    expect(md).toContain('Conventional commits.');
    // both link targets are symlinks pointing at the canonical dir
    for (const root of [roots.claude, roots.codex]) {
      const link = path.join(root, 'commit-style');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.resolve(root, readlinkSync(link))).toBe(
        path.resolve(path.join(roots.pinloom, 'commit-style')),
      );
    }
  });

  it('updates in place on a second save (links already point at source)', () => {
    saveSkill({ name: 's1', scope: 'global', description: 'd', body: 'v1' }, roots);
    const r = saveSkill({ name: 's1', scope: 'global', description: 'd2', body: 'v2' }, roots);
    expect(r.action).toBe('updated');
    expect(r.links).toEqual({ claude: 'linked', codex: 'linked' });
    expect(readFileSync(path.join(roots.pinloom, 's1', 'SKILL.md'), 'utf8')).toContain('v2');
  });

  it('refuses to clobber a real directory at the link target (conflict)', async () => {
    // a user-owned real dir already occupies ~/.claude/skills/dup
    await mkdir(path.join(roots.claude, 'dup'), { recursive: true });
    await writeFile(path.join(roots.claude, 'dup', 'SKILL.md'), 'USER OWNED', 'utf8');
    const r = saveSkill({ name: 'dup', scope: 'global', description: 'd', body: 'b' }, roots);
    expect(r.links!.claude).toBe('conflict');
    expect(r.links!.codex).toBe('linked');
    // the user's file is untouched
    expect(readFileSync(path.join(roots.claude, 'dup', 'SKILL.md'), 'utf8')).toBe('USER OWNED');
  });

  it('treats a user-owned symlink pointing outside our root as a conflict', async () => {
    const elsewhere = path.join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(roots.claude, { recursive: true });
    await symlink(elsewhere, path.join(roots.claude, 'uc'));
    const r = saveSkill({ name: 'uc', scope: 'global', description: 'd', body: 'b' }, roots);
    expect(r.links!.claude).toBe('conflict');
    // the user's link is left pointing where they put it
    expect(path.resolve(roots.claude, readlinkSync(path.join(roots.claude, 'uc')))).toBe(
      path.resolve(elsewhere),
    );
  });

  it('repoints a stale pinloom-owned symlink (points inside our root)', async () => {
    await mkdir(path.join(roots.pinloom, 'old-target'), { recursive: true });
    await mkdir(roots.claude, { recursive: true });
    // a prior pinloom link that points inside the pinloom skills root
    await symlink(path.join(roots.pinloom, 'old-target'), path.join(roots.claude, 'rp'));
    const r = saveSkill({ name: 'rp', scope: 'global', description: 'd', body: 'b' }, roots);
    expect(r.links!.claude).toBe('repointed');
    expect(path.resolve(roots.claude, readlinkSync(path.join(roots.claude, 'rp')))).toBe(
      path.resolve(path.join(roots.pinloom, 'rp')),
    );
  });

  it('validates description and body', () => {
    expect(() => saveSkill({ name: 'x', scope: 'global', description: '', body: 'b' }, roots)).toThrow(SkillError);
    expect(() => saveSkill({ name: 'x', scope: 'global', description: 'd', body: '  ' }, roots)).toThrow(SkillError);
  });
});

describe('saveSkill (project)', () => {
  it('writes into <projectCwd>/.claude/skills and does not symlink', async () => {
    const proj = path.join(base, 'proj');
    await mkdir(proj, { recursive: true });
    const r = saveSkill(
      { name: 'proj-conv', scope: 'project', description: 'd', body: 'b', projectCwd: proj },
      roots,
    );
    expect(r.action).toBe('created');
    expect(r.links).toBeUndefined();
    expect(existsSync(path.join(proj, '.claude', 'skills', 'proj-conv', 'SKILL.md'))).toBe(true);
    // global roots untouched
    expect(existsSync(path.join(roots.pinloom, 'proj-conv'))).toBe(false);
  });

  it('rejects a missing or relative projectCwd', () => {
    expect(() => saveSkill({ name: 'x', scope: 'project', description: 'd', body: 'b' }, roots)).toThrow(SkillError);
    expect(() =>
      saveSkill({ name: 'x', scope: 'project', description: 'd', body: 'b', projectCwd: 'rel/path' }, roots),
    ).toThrow(SkillError);
    expect(() =>
      saveSkill({ name: 'x', scope: 'project', description: 'd', body: 'b', projectCwd: '/no/such/dir' }, roots),
    ).toThrow(SkillError);
  });
});

describe('listSkills', () => {
  it('lists global skills with link status', () => {
    saveSkill({ name: 'a-skill', scope: 'global', description: 'desc a', body: 'b' }, roots);
    const list = listSkills('global', { roots });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'a-skill',
      description: 'desc a',
      scope: 'global',
      linkedClaude: true,
      linkedCodex: true,
    });
  });

  it('lists project skills', async () => {
    const proj = path.join(base, 'proj');
    await mkdir(proj, { recursive: true });
    saveSkill({ name: 'p-skill', scope: 'project', description: 'pd', body: 'b', projectCwd: proj }, roots);
    const list = listSkills('project', { projectCwd: proj });
    expect(list.map((s) => s.name)).toEqual(['p-skill']);
    expect(list[0].scope).toBe('project');
  });
});
