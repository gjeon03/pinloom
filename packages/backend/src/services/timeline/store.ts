// Work Timeline (L1) storage — per-project, per-day markdown journal entries
// (docs/knowledge-system-v3.md §3). Layout:
//
//   ~/.pinloom/timeline/<project-slug>/YYYY-MM-DD.md
//
// Distinct from the convention wiki (L2) — this is append-only dated history
// ("what I did + why on day D"), auto-distilled from sessions + git commits.
// Files on disk the user controls (same convention as the wiki). `home` is
// injectable so tests never touch the real ~/.pinloom.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

// Project slugs come from getProjectWikiSlugByProjectId / wiki-sync's slugify,
// which keeps [A-Za-z0-9._-] (so a dir basename like "My_App.v2" stays). Accept
// that SAME charset, but require an alphanumeric first char and forbid "/" — so
// a slug is always a single flat path segment that can't escape the root (a
// leading "." / ".." is rejected by the first-char class; there's no separator).
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 100) {
    throw new TimelineError(`invalid project slug: ${slug}`);
  }
}

export function assertDate(date: string): void {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new TimelineError(`invalid date (want YYYY-MM-DD): ${date}`);
  }
}

export function getTimelineRoot(home: string = os.homedir()): string {
  return path.join(home, '.pinloom', 'timeline');
}

function projectDir(slug: string, home?: string): string {
  assertSlug(slug);
  return path.join(getTimelineRoot(home), slug);
}

function entryFile(slug: string, date: string, home?: string): string {
  assertDate(date);
  return path.join(projectDir(slug, home), `${date}.md`);
}

/** The markdown for one project-day, or null if no entry exists yet. */
export function readEntry(slug: string, date: string, home?: string): string | null {
  const file = entryFile(slug, date, home);
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

export function writeEntry(
  slug: string,
  date: string,
  markdown: string,
  home?: string,
): void {
  const file = entryFile(slug, date, home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, markdown, 'utf8');
}

/** Dates (YYYY-MM-DD) that have an entry for a project, newest first. */
export function listDates(slug: string, home?: string): string[] {
  const dir = projectDir(slug, home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && DATE_RE.test(f.slice(0, -3)))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => b.localeCompare(a));
}

/** Project slugs that have any timeline entries. */
export function listSlugs(home?: string): string[] {
  const root = getTimelineRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

export interface GlobalDateEntry {
  slug: string;
  markdown: string;
}

/** All projects' entries for a single date — the cross-project "what did I do on
 *  D, everywhere" view, aggregated at read time (not a second store). */
export function globalDateView(date: string, home?: string): GlobalDateEntry[] {
  assertDate(date);
  const out: GlobalDateEntry[] = [];
  for (const slug of listSlugs(home)) {
    const md = readEntry(slug, date, home);
    if (md !== null) out.push({ slug, markdown: md });
  }
  return out;
}
