// Snapshot the wiki tree into the backup git working directory. The
// session DB is intentionally NOT included here — those live on a
// separate file-based export/import path (see db-export.ts) so the git
// repo stays text-friendly (diff/blame meaningful) and the DB doesn't
// churn the repo with large opaque commits.
//
//   <backup_dir>/
//     manifest.json
//     wiki/                            # mirror of ~/.pinloom/wiki/
//
// The wiki/ directory is wiped before each export so deletions in the
// source tree propagate as deletions in the commit. Anything outside
// wiki/ + manifest.json (README, .git, .gitignore) is left alone.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getWikiRoot } from './wiki-sync.js';

const SCHEMA_VERSION = 2;

async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function copyDir(src: string, dest: string): Promise<void> {
  try {
    await fs.access(src);
  } catch {
    return;
  }
  await fs.cp(src, dest, { recursive: true, force: true });
}

async function dirSize(p: string): Promise<number> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += await dirSize(full);
      else {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export interface ExportSummary {
  wikiBytes: number;
  exportedAt: string;
}

export async function exportAll(backupDir: string): Promise<ExportSummary> {
  // Clear prior wiki snapshot so deletes propagate.
  await rmrf(path.join(backupDir, 'wiki'));

  const wikiSrc = getWikiRoot();
  const wikiDst = path.join(backupDir, 'wiki');
  await copyDir(wikiSrc, wikiDst);
  const wikiBytes = await dirSize(wikiDst);

  const summary: ExportSummary = {
    wikiBytes,
    exportedAt: new Date().toISOString(),
  };

  await writeJson(path.join(backupDir, 'manifest.json'), {
    schemaVersion: SCHEMA_VERSION,
    kind: 'wiki-only',
    ...summary,
  });

  return summary;
}
