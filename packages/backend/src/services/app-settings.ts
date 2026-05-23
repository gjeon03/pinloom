// Generic key/value store for app-level settings. First and only caller
// today is the GitHub backup feature (token / remote URL / last sync).
// Values are stored verbatim — the UI is responsible for telling the
// operator that this DB file is as sensitive as the token itself.

import { getDb } from '../db/connection.js';

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as Pick<AppSettingRow, 'value'> | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value      = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, value, now);
}

export function deleteSetting(key: string): boolean {
  const result = getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  return result.changes > 0;
}

// Backup-specific keys, kept here so callers don't sprinkle string
// literals through the codebase.
export const BackupSettingKey = {
  GithubToken: 'backup.github.token',
  GithubUser: 'backup.github.user',
  RepoFullName: 'backup.repo.full_name',
  RepoCloneUrl: 'backup.repo.clone_url',
  LastSyncAt: 'backup.last_sync_at',
} as const;
