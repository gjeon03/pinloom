// Curation-engine foundation (docs/knowledge-system-v2.md, Phase 2a) — the
// code-level safety primitives the wiki gardener (Phase 2b) will build on.
// NO LLM here: these are deterministic, byte-precise functions so an
// agent-proposed change can be applied without ever trusting the agent to
// respect the auto-section markers or to not clobber/lose user content.
//
//   - spliceAutoSection: pinloom owns the splice — only the bytes between the
//     markers change; new content that itself contains a marker is rejected so
//     it can never break out into user territory.
//   - assertOnlyAutoSectionChanged: validate an agent's FULL-page proposal —
//     reject it unless the only difference is inside the markers.
//   - archivePage / restorePage / listArchive: "archive, never delete". The
//     page is moved only AFTER its manifest entry is durably recorded, all
//     manifest mutations are serialized (no read-modify-write race), and the
//     source is symlink/traversal-guarded — so user content is never lost.

import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWikiRoot } from './wiki-reader.js';

export const AUTO_SECTION_OPEN = '<!-- pinloom:auto-section -->';
export const AUTO_SECTION_CLOSE = '<!-- /pinloom:auto-section -->';

export class CurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurationError';
  }
}

interface MarkerSplit {
  /** Everything up to and including the open marker. */
  before: string;
  /** The raw text between the markers (may include surrounding newlines). */
  inside: string;
  /** The close marker and everything after it. */
  after: string;
  hasMarkers: boolean;
}

function splitByMarkers(text: string): MarkerSplit {
  const open = text.indexOf(AUTO_SECTION_OPEN);
  if (open === -1) {
    return { before: text, inside: '', after: '', hasMarkers: false };
  }
  const innerStart = open + AUTO_SECTION_OPEN.length;
  const close = text.indexOf(AUTO_SECTION_CLOSE, innerStart);
  if (close === -1) {
    throw new CurationError('page has an open auto-section marker with no close');
  }
  return {
    before: text.slice(0, innerStart),
    inside: text.slice(innerStart, close),
    after: text.slice(close),
    hasMarkers: true,
  };
}

/**
 * Replace ONLY the content between the auto-section markers with `newContent`.
 * Everything outside (frontmatter, user-owned prose) is preserved byte-for-byte.
 * A marker-less page gets a fresh auto-section appended (the existing content
 * stays user-owned). `newContent` may not contain a marker string itself —
 * that would let the splice plant bytes outside the section, so it is rejected.
 */
export function spliceAutoSection(pageText: string, newContent: string): string {
  if (
    newContent.includes(AUTO_SECTION_OPEN) ||
    newContent.includes(AUTO_SECTION_CLOSE)
  ) {
    throw new CurationError(
      'auto-section content may not contain a pinloom:auto-section marker',
    );
  }
  const inner = newContent.replace(/^\n+/, '').replace(/\n+$/, '');
  const split = splitByMarkers(pageText);
  if (!split.hasMarkers) {
    const base = pageText.endsWith('\n') || pageText === '' ? pageText : `${pageText}\n`;
    return `${base}\n${AUTO_SECTION_OPEN}\n${inner}\n${AUTO_SECTION_CLOSE}\n`;
  }
  const result = `${split.before}\n${inner}\n${split.after}`;
  // Defence in depth: the result must differ from the input ONLY inside the
  // markers. (Cheap, and catches any future edge the string surgery missed.)
  assertOnlyAutoSectionChanged(pageText, result);
  return result;
}

/** The current auto-section content, or null when the page has no markers. */
export function readAutoSection(pageText: string): string | null {
  const split = splitByMarkers(pageText);
  if (!split.hasMarkers) return null;
  return split.inside.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Validate a full-page proposal: throw unless the ONLY difference from the
 * original is inside the auto-section markers. Both must keep the markers.
 * This is the gate for any agent-authored page text before it is written.
 */
export function assertOnlyAutoSectionChanged(
  original: string,
  proposed: string,
): void {
  const o = splitByMarkers(original);
  const p = splitByMarkers(proposed);
  if (!o.hasMarkers || !p.hasMarkers) {
    throw new CurationError(
      'both original and proposed pages must contain auto-section markers',
    );
  }
  if (o.before !== p.before) {
    throw new CurationError(
      'proposal changed content before the auto-section (frontmatter / user prose)',
    );
  }
  if (o.after !== p.after) {
    throw new CurationError(
      'proposal changed content after the auto-section (user prose)',
    );
  }
}

// ─── per-page archive / restore ───

const ARCHIVE_DIRNAME = '_archive';
const MANIFEST_NAME = 'manifest.json';

export interface ArchiveEntry {
  /** File name under _archive/ (collision-safe, always a flat single segment). */
  archivedName: string;
  /** Path relative to pages/, for restore. */
  originalRelPath: string;
  reason: string;
  proposalId: string | null;
  supersededBy: string | null;
  archivedAt: string;
}

// Reject anything that would escape pages/ (zip-slip style) or isn't a plain
// relative file path.
function assertSafeRelPath(relPath: string): void {
  if (
    !relPath ||
    path.isAbsolute(relPath) ||
    relPath.split(/[/\\]/).some((seg) => seg === '..' || seg === '')
  ) {
    throw new CurationError(`unsafe page path: ${JSON.stringify(relPath)}`);
  }
}

// An archived file name must be a single flat segment (no separators, no `..`).
function assertFlatName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new CurationError(`unsafe archive name: ${JSON.stringify(name)}`);
  }
}

// Serialize every manifest mutation. The manifest is a read-modify-write file,
// so without this two concurrent archives would clobber each other's entries.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readManifest(archiveDir: string): Promise<ArchiveEntry[]> {
  const file = path.join(archiveDir, MANIFEST_NAME);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new CurationError('archive manifest is corrupt (invalid JSON)');
  }
  if (!Array.isArray(parsed)) {
    throw new CurationError('archive manifest is corrupt (not an array)');
  }
  return parsed as ArchiveEntry[];
}

async function writeManifest(
  archiveDir: string,
  entries: ArchiveEntry[],
): Promise<void> {
  await writeFile(
    path.join(archiveDir, MANIFEST_NAME),
    `${JSON.stringify(entries, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Move a page out of pages/ into _archive/ and record it in the manifest.
 * `root` is the wiki root (injectable for tests); `now` is the timestamp
 * (injected so callers/tests stay deterministic). The manifest entry is
 * written BEFORE the file is moved, and the move is rolled back if the move
 * fails — the page is never lost, only ever a recoverable phantom entry.
 */
export function archivePage(
  relPath: string,
  meta: { reason: string; proposalId?: string | null; supersededBy?: string | null },
  opts: { root?: string; now: string },
): Promise<ArchiveEntry> {
  return withLock(async () => {
    assertSafeRelPath(relPath);
    const root = opts.root ?? getWikiRoot();
    const src = path.join(root, 'pages', relPath);
    let stat;
    try {
      stat = await lstat(src);
    } catch {
      throw new CurationError(`page not found: ${relPath}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      // Archiving a symlink would move the link, not the bytes — a backup of
      // _archive/ would then capture nothing. Refuse.
      throw new CurationError(`refusing to archive non-regular file: ${relPath}`);
    }
    const archiveDir = path.join(root, ARCHIVE_DIRNAME);
    await mkdir(archiveDir, { recursive: true });

    const entries = await readManifest(archiveDir);
    const taken = new Set(entries.map((e) => e.archivedName));
    const flattened = relPath.replace(/[/\\]/g, '__');
    let archivedName = flattened;
    let n = 1;
    while (taken.has(archivedName) || existsSync(path.join(archiveDir, archivedName))) {
      archivedName = `${flattened}.${n}`;
      n += 1;
    }

    const entry: ArchiveEntry = {
      archivedName,
      originalRelPath: relPath,
      reason: meta.reason,
      proposalId: meta.proposalId ?? null,
      supersededBy: meta.supersededBy ?? null,
      archivedAt: opts.now,
    };
    // Record intent first (page still safe in pages/), then move.
    await writeManifest(archiveDir, [...entries, entry]);
    try {
      await rename(src, path.join(archiveDir, archivedName));
    } catch (err) {
      // Roll the entry back so we don't leave a phantom pointing at a file
      // that's still live in pages/.
      await writeManifest(archiveDir, entries).catch(() => undefined);
      throw new CurationError(
        `failed to archive ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return entry;
  });
}

/** List archived pages whose file actually exists (most-recent first). */
export function listArchive(root?: string): Promise<ArchiveEntry[]> {
  return withLock(async () => {
    const archiveDir = path.join(root ?? getWikiRoot(), ARCHIVE_DIRNAME);
    const entries = await readManifest(archiveDir);
    // Drop phantom entries (manifest recorded but the move never completed) so
    // the UI only ever offers genuinely-restorable pages.
    const live = entries.filter((e) =>
      existsSync(path.join(archiveDir, e.archivedName)),
    );
    return [...live].reverse();
  });
}

/**
 * Move an archived page back to its original path under pages/ and drop its
 * manifest entry. Refuses to clobber a page that now exists at that path.
 */
export function restorePage(
  archivedName: string,
  root?: string,
): Promise<ArchiveEntry> {
  return withLock(async () => {
    assertFlatName(archivedName);
    const wikiRoot = root ?? getWikiRoot();
    const archiveDir = path.join(wikiRoot, ARCHIVE_DIRNAME);
    const entries = await readManifest(archiveDir);
    const idx = entries.findIndex((e) => e.archivedName === archivedName);
    if (idx === -1) {
      throw new CurationError(`no archived page named ${archivedName}`);
    }
    const entry = entries[idx];
    assertSafeRelPath(entry.originalRelPath);
    const src = path.join(archiveDir, archivedName);
    if (!existsSync(src)) {
      throw new CurationError(`archived file is missing: ${archivedName}`);
    }
    const dest = path.join(wikiRoot, 'pages', entry.originalRelPath);
    if (existsSync(dest)) {
      throw new CurationError(
        `cannot restore: a page already exists at ${entry.originalRelPath}`,
      );
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(src, dest);
    entries.splice(idx, 1);
    await writeManifest(archiveDir, entries);
    return entry;
  });
}
