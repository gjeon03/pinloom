// Wiki-only restore from the backup repo. Sessions are restored via the
// separate file-based DB import path (db-import.ts).
//
// Wiki files are copied skip-if-exists so re-running restore is a no-op
// and so local edits since the last sync aren't clobbered. After restore
// the user can run a sync to publish any newer local wiki state.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getWikiRoot } from './wiki-sync.js';

export interface ImportSummary {
  wikiFilesImported: number;
  wikiFilesSkipped: number;
}

async function copyFileSkipIfExists(
  src: string,
  dst: string,
): Promise<boolean> {
  try {
    await fs.access(dst);
    return false;
  } catch {
    // not present, fall through to copy
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  return true;
}

async function copyWikiTree(
  src: string,
  dst: string,
  summary: ImportSummary,
): Promise<void> {
  try {
    await fs.access(src);
  } catch {
    return;
  }
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyWikiTree(s, d, summary);
    } else if (entry.isFile()) {
      const copied = await copyFileSkipIfExists(s, d);
      if (copied) summary.wikiFilesImported += 1;
      else summary.wikiFilesSkipped += 1;
    }
  }
}

export async function importAll(backupDir: string): Promise<ImportSummary> {
  const summary: ImportSummary = {
    wikiFilesImported: 0,
    wikiFilesSkipped: 0,
  };
  await copyWikiTree(path.join(backupDir, 'wiki'), getWikiRoot(), summary);
  return summary;
}
