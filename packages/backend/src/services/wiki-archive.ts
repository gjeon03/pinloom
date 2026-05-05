import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const BACKUP_DIR = path.join(os.homedir(), '.pinloom', 'wiki-backups');

// Anything matching one of these path segments is excluded from the archive
// so we don't (a) ship our own backup zips back into the export or (b) blow
// up on filesystem-special files.
const EXCLUDE_SEGMENTS = new Set(['wiki-backups', '.DS_Store']);

export type ImportMode = 'skip' | 'overwrite';

export interface ImportSummary {
  mode: ImportMode;
  added: string[];
  overwritten: string[];
  skipped: string[];
  backupPath: string;
}

async function* walk(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      yield* walk(full, base);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

async function buildZipFromDir(dir: string): Promise<Buffer> {
  const zip = new JSZip();
  for await (const rel of walk(dir, dir)) {
    const full = path.join(dir, rel);
    const data = await readFile(full);
    // Use forward slashes inside the zip regardless of host OS.
    zip.file(rel.split(path.sep).join('/'), data);
  }
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function exportWikiZip(): Promise<Buffer> {
  if (!existsSync(WIKI_ROOT)) {
    // Empty wiki — return a zip with just a placeholder so downloads still
    // succeed. The caller can decide whether to surface that as an error.
    const empty = new JSZip();
    empty.file('README.txt', 'No wiki content yet — ~/.pinloom/wiki/ is empty.\n');
    return await empty.generateAsync({ type: 'nodebuffer' });
  }
  return buildZipFromDir(WIKI_ROOT);
}

function timestamp(): string {
  // 2026-05-06T01-23-45 — filesystem-safe ISO-ish, sortable.
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

export async function backupWikiZip(): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const filename = `wiki-${timestamp()}.zip`;
  const backupPath = path.join(BACKUP_DIR, filename);

  if (!existsSync(WIKI_ROOT)) {
    // No live wiki to back up — write a marker zip so callers always have
    // a non-empty path to point at.
    const empty = new JSZip();
    empty.file('EMPTY.txt', 'No wiki content was present at backup time.\n');
    await writeFile(backupPath, await empty.generateAsync({ type: 'nodebuffer' }));
    return backupPath;
  }

  const buf = await buildZipFromDir(WIKI_ROOT);
  await writeFile(backupPath, buf);
  return backupPath;
}

// Reject paths that would escape WIKI_ROOT (zip-slip) or look like absolute
// filesystem references. We only accept relative, forward-slash paths that
// don't contain '..' segments.
function safeRelativePath(zipEntryPath: string): string | null {
  if (!zipEntryPath) return null;
  if (path.isAbsolute(zipEntryPath)) return null;
  const normalized = path.posix.normalize(zipEntryPath);
  if (normalized.startsWith('..')) return null;
  if (normalized.split('/').some((seg) => seg === '..' || EXCLUDE_SEGMENTS.has(seg))) {
    return null;
  }
  return normalized;
}

export async function importWikiZip(
  buffer: Buffer,
  opts: { mode: ImportMode },
): Promise<ImportSummary> {
  const zip = await JSZip.loadAsync(buffer);

  // Validate: archive must look like a wiki tree (have at least one .md file).
  const mdFiles = Object.keys(zip.files).filter(
    (name) => !zip.files[name].dir && name.endsWith('.md'),
  );
  if (mdFiles.length === 0) {
    throw new Error(
      'Archive contains no .md files — refusing to import (does not look like a wiki export).',
    );
  }

  // ALWAYS back up the current wiki before mutating it. This is the safety
  // net we want after the May 5 incident — even an "overwrite" import is
  // recoverable because we keep the prior state.
  const backupPath = await backupWikiZip();

  await mkdir(WIKI_ROOT, { recursive: true });

  const summary: ImportSummary = {
    mode: opts.mode,
    added: [],
    overwritten: [],
    skipped: [],
    backupPath,
  };

  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const safe = safeRelativePath(entryPath);
    if (!safe) {
      summary.skipped.push(`${entryPath} (unsafe path)`);
      continue;
    }
    const target = path.join(WIKI_ROOT, safe);

    let exists = false;
    try {
      await stat(target);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists && opts.mode === 'skip') {
      summary.skipped.push(safe);
      continue;
    }

    await mkdir(path.dirname(target), { recursive: true });
    const data = await entry.async('nodebuffer');
    await writeFile(target, data);

    if (exists) summary.overwritten.push(safe);
    else summary.added.push(safe);
  }

  return summary;
}
