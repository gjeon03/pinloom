// Skill writer for the skill bot. A "skill" is a Claude Code / Codex skill:
// a directory holding SKILL.md with `name` + `description` frontmatter (the
// description is the discovery trigger). Two scopes:
//
//   global  — single source at ~/.pinloom/skills/<name>/, symlinked into
//             ~/.claude/skills/<name> and ~/.codex/skills/<name> so both agents
//             see it from every project. Editing the source updates both links.
//   project — written directly into <projectCwd>/.claude/skills/<name>/ (real
//             files, version-controllable with the repo).
//
// Safety: names are validated as flat slugs (no traversal); we NEVER clobber a
// pre-existing real directory at a link target (only our own symlinks are
// repointed). Roots are injectable so unit tests never touch the real
// ~/.claude / ~/.codex / ~/.pinloom.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

export type SkillScope = 'global' | 'project';

export interface SkillRoots {
  pinloom: string; // ~/.pinloom/skills
  claude: string; // ~/.claude/skills
  codex: string; // ~/.codex/skills
}

export function defaultSkillRoots(home: string = os.homedir()): SkillRoots {
  return {
    pinloom: path.join(home, '.pinloom', 'skills'),
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.codex', 'skills'),
  };
}

// kebab-case slug, no slashes/dots/.. so it can never escape its parent dir.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_MAX = 1000;

export function assertSkillName(name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new SkillError(
      `invalid skill name "${name}" — use a kebab-case slug (a-z, 0-9, -), ≤ 64 chars`,
    );
  }
}

function buildSkillMd(name: string, description: string, body: string): string {
  // Description is the discovery trigger; collapse to one line and emit it as a
  // double-quoted YAML scalar so a leading special char (`>`, `|`, `:` …) can't
  // produce a scalar a strict frontmatter parser misreads.
  const desc = description
    .replace(/\r?\n/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  const trimmedBody = body.replace(/^\s+/, '').replace(/\s+$/, '');
  return `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${trimmedBody}\n`;
}

type LinkStatus = 'linked' | 'repointed' | 'conflict';

// Point <targetRoot>/<name> at canonicalDir. `pinloomRoot` is our skills source
// root — we only repoint a symlink that already points INSIDE it (a stale link
// we plausibly own). Returns 'conflict' for anything else we won't disturb: a
// real dir/file, OR a symlink the user created pointing somewhere of their own.
function linkInto(
  targetRoot: string,
  name: string,
  canonicalDir: string,
  pinloomRoot: string,
): LinkStatus {
  mkdirSync(targetRoot, { recursive: true });
  const target = path.join(targetRoot, name);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      let current: string | null = null;
      try {
        current = readlinkSync(target);
      } catch {
        current = null;
      }
      const resolved = current ? path.resolve(targetRoot, current) : null;
      if (resolved === path.resolve(canonicalDir)) {
        return 'linked'; // already points at our source
      }
      // Only repoint a link that lives inside our own skills root; a symlink
      // the user pointed elsewhere is theirs — treat as a conflict, don't hijack.
      const rootPrefix = path.resolve(pinloomRoot) + path.sep;
      if (resolved && (resolved + path.sep).startsWith(rootPrefix)) {
        rmSync(target);
        symlinkSync(canonicalDir, target);
        return 'repointed';
      }
      return 'conflict';
    }
    // A real dir/file the user owns — never destroy it.
    return 'conflict';
  }
  symlinkSync(canonicalDir, target);
  return 'linked';
}

export interface SkillSaveInput {
  name: string;
  scope: SkillScope;
  description: string;
  body: string;
  /** Absolute cwd of the target project — required for scope 'project'. */
  projectCwd?: string;
}

export interface SkillSaveResult {
  name: string;
  scope: SkillScope;
  action: 'created' | 'updated';
  path: string;
  /** For global skills: how the claude/codex links resolved. */
  links?: { claude: LinkStatus; codex: LinkStatus };
}

export function saveSkill(
  input: SkillSaveInput,
  roots: SkillRoots = defaultSkillRoots(),
): SkillSaveResult {
  assertSkillName(input.name);
  const description = (input.description ?? '').trim();
  if (!description) throw new SkillError('description is required');
  if (description.length > DESCRIPTION_MAX) {
    throw new SkillError(`description too long (max ${DESCRIPTION_MAX} chars)`);
  }
  if (!input.body || !input.body.trim()) {
    throw new SkillError('skill body is required');
  }

  const content = buildSkillMd(input.name, description, input.body);

  if (input.scope === 'project') {
    if (!input.projectCwd || !path.isAbsolute(input.projectCwd)) {
      throw new SkillError('project scope requires an absolute projectCwd');
    }
    if (!existsSync(input.projectCwd)) {
      throw new SkillError(`project directory does not exist: ${input.projectCwd}`);
    }
    const dir = path.join(input.projectCwd, '.claude', 'skills', input.name);
    const existed = existsSync(path.join(dir, 'SKILL.md'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    return {
      name: input.name,
      scope: 'project',
      action: existed ? 'updated' : 'created',
      path: dir,
    };
  }

  // global
  const canonicalDir = path.join(roots.pinloom, input.name);
  const existed = existsSync(path.join(canonicalDir, 'SKILL.md'));
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(path.join(canonicalDir, 'SKILL.md'), content, 'utf8');
  const links = {
    claude: linkInto(roots.claude, input.name, canonicalDir, roots.pinloom),
    codex: linkInto(roots.codex, input.name, canonicalDir, roots.pinloom),
  };
  return {
    name: input.name,
    scope: 'global',
    action: existed ? 'updated' : 'created',
    path: canonicalDir,
    links,
  };
}

export interface SkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
  /** global only: whether the claude/codex symlinks point at our source. */
  linkedClaude?: boolean;
  linkedCodex?: boolean;
}

function readDescription(skillMd: string): string {
  const m = skillMd.match(/^description:\s*(.+)$/m);
  if (!m) return '';
  let v = m[1].trim();
  // Unwrap the double-quoted scalar buildSkillMd emits (tolerate unquoted too).
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

function isLinkedTo(targetRoot: string, name: string, canonicalDir: string): boolean {
  const target = path.join(targetRoot, name);
  try {
    if (!lstatSync(target).isSymbolicLink()) return false;
    const current = readlinkSync(target);
    return path.resolve(targetRoot, current) === path.resolve(canonicalDir);
  } catch {
    return false;
  }
}

function listSkillsInDir(dir: string, scope: SkillScope): SkillSummary[] {
  if (!existsSync(dir)) return [];
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // follows symlinks for global; project skills are real dirs.
    const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    let description = '';
    try {
      description = readDescription(readFileSync(skillMdPath, 'utf8'));
    } catch {
      description = '';
    }
    out.push({ name: entry.name, description, scope });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(
  scope: SkillScope,
  opts: { projectCwd?: string; roots?: SkillRoots } = {},
): SkillSummary[] {
  const roots = opts.roots ?? defaultSkillRoots();
  if (scope === 'project') {
    if (!opts.projectCwd) throw new SkillError('project scope requires projectCwd');
    return listSkillsInDir(path.join(opts.projectCwd, '.claude', 'skills'), 'project');
  }
  return listSkillsInDir(roots.pinloom, 'global').map((s) => {
    const canonicalDir = path.join(roots.pinloom, s.name);
    return {
      ...s,
      linkedClaude: isLinkedTo(roots.claude, s.name, canonicalDir),
      linkedCodex: isLinkedTo(roots.codex, s.name, canonicalDir),
    };
  });
}
