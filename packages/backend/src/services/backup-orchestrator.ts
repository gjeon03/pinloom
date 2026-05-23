// High-level sync flow for the WIKI half of the backup feature: ensure
// the local backup repo is present, mirror the wiki tree into it, then
// commit and push. Session-DB backup runs through the separate
// db-export.ts / db-import.ts file path — that one is decoupled from
// git because shoving the DB JSON into commits produced churn the user
// couldn't usefully diff or merge.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BackupSettingKey,
  getSetting,
  setSetting,
} from './app-settings.js';
import { authenticatedRemoteUrl } from './github-api.js';
import * as git from './git-ops.js';
import { exportAll, type ExportSummary } from './backup-export.js';
import { importAll, type ImportSummary } from './backup-import.js';

const BACKUP_DIR = path.join(os.homedir(), '.pinloom', 'backup');

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

interface SyncResult {
  exported: ExportSummary;
  committed: boolean;
  pushed: boolean;
  message: string;
}

// Serialize sync invocations — concurrent syncs would race on the git
// index and the export wipe. The orchestrator is the only writer here,
// so a single in-process mutex is sufficient. Restore shares the same
// mutex because it also pulls from the same working tree.
let activeSync: Promise<SyncResult> | null = null;
let activeRestore: Promise<RestoreResult> | null = null;

export function getBackupWorkingDir(): string {
  return BACKUP_DIR;
}

// Compare clone URLs ignoring credentials — the remote URL git records
// has the token embedded, but the user-configured cloneUrl does not.
// Equality on host + pathname is what we actually care about; anything
// else (scheme, query, etc.) is identical for github.com.
function stripCredentials(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\.git$/, '')}`;
  } catch {
    return url;
  }
}

export async function runSync(): Promise<SyncResult> {
  if (activeSync) {
    return activeSync;
  }
  activeSync = runSyncInner().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function ensureRepo(): Promise<{
  cloneUrl: string;
  authedUrl: string;
  authorName: string;
  authorEmail: string;
}> {
  const token = getSetting(BackupSettingKey.GithubToken);
  const cloneUrl = getSetting(BackupSettingKey.RepoCloneUrl);
  const login = getSetting(BackupSettingKey.GithubUser);
  if (!token) throw new BackupError('GitHub token not configured');
  if (!cloneUrl) throw new BackupError('Backup repository not configured');
  if (!login) throw new BackupError('GitHub user not configured');

  const authedUrl = authenticatedRemoteUrl(cloneUrl, token);
  const authorName = login;
  // GitHub's noreply scheme for users that haven't published an email.
  // The `${login}@users.noreply.github.com` form is accepted on any
  // repo regardless of the user's email privacy setting.
  const authorEmail = `${login}@users.noreply.github.com`;

  // First-time setup: clone into BACKUP_DIR. We refuse to overwrite an
  // existing non-empty dir that isn't already a git repo to avoid
  // clobbering local state someone may have parked there.
  let isRepo = false;
  try {
    await fs.access(BACKUP_DIR);
    isRepo = await git.isGitRepo(BACKUP_DIR);
    if (!isRepo) {
      const entries = await fs.readdir(BACKUP_DIR);
      if (entries.length > 0) {
        throw new BackupError(
          `${BACKUP_DIR} exists and is not a git repo — move or delete it before syncing`,
        );
      }
      // Empty dir — remove it so `git clone` can recreate cleanly.
      await fs.rmdir(BACKUP_DIR);
    }
  } catch (err) {
    if (
      err instanceof BackupError ||
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      if (err instanceof BackupError) throw err;
    }
  }

  // If the existing clone points at a different repo than the one
  // currently configured (user switched repos), the local history is
  // unrelated to the new remote and `git pull` would fail with a
  // "diverging branches" error. Wipe and re-clone so the operator
  // doesn't have to clean up ~/.pinloom/backup/ by hand.
  if (isRepo) {
    const currentRemote = await git.getRemoteUrl(BACKUP_DIR);
    if (
      currentRemote === null ||
      stripCredentials(currentRemote) !== stripCredentials(cloneUrl)
    ) {
      await fs.rm(BACKUP_DIR, { recursive: true, force: true });
      isRepo = false;
    }
  }

  if (!isRepo) {
    await fs.mkdir(path.dirname(BACKUP_DIR), { recursive: true });
    await git.clone(authedUrl, BACKUP_DIR);
  } else {
    // Re-bind the remote URL on every sync. Token may have been rotated
    // since the last clone; a stale embedded token would otherwise make
    // push fail silently.
    await git.setRemoteUrl(BACKUP_DIR, authedUrl);
  }

  return { cloneUrl, authedUrl, authorName, authorEmail };
}

async function runSyncInner(): Promise<SyncResult> {
  let creds = await ensureRepo();

  // Fetch the latest in case another machine pushed since we last
  // synced. Three classes of failure we explicitly recover from:
  //   - empty remote (no commits yet) — proceed with a fresh export
  //   - diverging history — the local clone is unrelated to the current
  //     remote (commonly: user switched repos and the URL mismatch path
  //     missed it because a previous sync rewrote the remote URL on
  //     stale commits). Wipe BACKUP_DIR and clone fresh.
  //   - everything else — re-raise so the operator sees it.
  try {
    await git.pullFastForward(BACKUP_DIR);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/couldn't find remote ref|no such ref|no upstream/i.test(message)) {
      // empty remote — fine, fall through
    } else if (
      /diverging|not possible to fast-forward|fast-forwarded|unrelated histories/i.test(
        message,
      )
    ) {
      await fs.rm(BACKUP_DIR, { recursive: true, force: true });
      creds = await ensureRepo();
    } else {
      throw err;
    }
  }

  const exported = await exportAll(BACKUP_DIR);

  await git.addAll(BACKUP_DIR);
  const commitResult = await git.commit(BACKUP_DIR, {
    message: `pinloom wiki snapshot ${exported.exportedAt}`,
    authorName: creds.authorName,
    authorEmail: creds.authorEmail,
  });

  let pushed = false;
  if (commitResult.committed) {
    await git.push(BACKUP_DIR);
    pushed = true;
    setSetting(BackupSettingKey.LastSyncAt, exported.exportedAt);
  } else {
    // Still record the attempt so the UI shows "Last sync" even when
    // nothing changed; otherwise users assume sync didn't run.
    setSetting(BackupSettingKey.LastSyncAt, exported.exportedAt);
  }

  return {
    exported,
    committed: commitResult.committed,
    pushed,
    message: commitResult.message,
  };
}

export interface RestoreResult {
  imported: ImportSummary;
  fromCommit: string | null;
}

export async function runRestore(): Promise<RestoreResult> {
  if (activeRestore) return activeRestore;
  activeRestore = runRestoreInner().finally(() => {
    activeRestore = null;
  });
  return activeRestore;
}

async function runRestoreInner(): Promise<RestoreResult> {
  await ensureRepo();

  // Best-effort fast-forward, same recovery shape as runSync — wipe and
  // re-clone if local history is unrelated to the configured remote so
  // restoring across a repo switch doesn't surface a raw git error.
  try {
    await git.pullFastForward(BACKUP_DIR);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/couldn't find remote ref|no such ref|no upstream/i.test(message)) {
      // empty remote — fine, nothing to restore from
    } else if (
      /diverging|not possible to fast-forward|fast-forwarded|unrelated histories/i.test(
        message,
      )
    ) {
      await fs.rm(BACKUP_DIR, { recursive: true, force: true });
      await ensureRepo();
    } else {
      throw err;
    }
  }

  const imported = await importAll(BACKUP_DIR);

  return { imported, fromCommit: null };
}
