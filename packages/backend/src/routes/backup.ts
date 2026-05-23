// Backup feature endpoints. Wiki half rides the GitHub repo; DB half
// is a download/upload file path so the operator picks where the heavy
// JSON ends up (git history of the DB blob wasn't useful enough to
// justify the per-commit churn).

import type { FastifyInstance } from 'fastify';
import {
  BackupSettingKey,
  deleteSetting,
  getSetting,
  setSetting,
} from '../services/app-settings.js';
import {
  createRepo,
  fetchAuthenticatedUser,
  GithubApiError,
  listUserRepos,
} from '../services/github-api.js';
import {
  BackupError,
  runRestore,
  runSync,
} from '../services/backup-orchestrator.js';
import { buildDbExport } from '../services/db-export.js';
import { DbImportError, importDbFile } from '../services/db-import.js';

interface BackupConfigResponse {
  connected: boolean;
  user: { login: string } | null;
  repo: { fullName: string; cloneUrl: string } | null;
  lastSyncAt: string | null;
}

function readConfig(): BackupConfigResponse {
  const token = getSetting(BackupSettingKey.GithubToken);
  const login = getSetting(BackupSettingKey.GithubUser);
  const repoFullName = getSetting(BackupSettingKey.RepoFullName);
  const repoCloneUrl = getSetting(BackupSettingKey.RepoCloneUrl);
  return {
    connected: token !== null,
    user: token && login ? { login } : null,
    repo:
      token && repoFullName && repoCloneUrl
        ? { fullName: repoFullName, cloneUrl: repoCloneUrl }
        : null,
    lastSyncAt: getSetting(BackupSettingKey.LastSyncAt),
  };
}

export async function backupRoutes(app: FastifyInstance) {
  app.get('/api/settings/backup', async () => readConfig());

  // Set or replace the GitHub token. We validate it by calling /user —
  // a successful call means the token has at least basic identification
  // scope, which is also all the rest of the flow needs from the API.
  app.put<{ Body: { token?: unknown } }>(
    '/api/settings/backup/token',
    async (req, reply) => {
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (token.length === 0) {
        reply.code(400);
        return { error: 'token must be a non-empty string' };
      }
      try {
        const user = await fetchAuthenticatedUser(token);
        setSetting(BackupSettingKey.GithubToken, token);
        setSetting(BackupSettingKey.GithubUser, user.login);
        return readConfig();
      } catch (err) {
        if (err instanceof GithubApiError && err.status === 401) {
          reply.code(400);
          return { error: 'GitHub rejected the token (401). Check scopes and expiry.' };
        }
        reply.code(502);
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  app.delete('/api/settings/backup/token', async () => {
    deleteSetting(BackupSettingKey.GithubToken);
    deleteSetting(BackupSettingKey.GithubUser);
    deleteSetting(BackupSettingKey.RepoFullName);
    deleteSetting(BackupSettingKey.RepoCloneUrl);
    deleteSetting(BackupSettingKey.LastSyncAt);
    return readConfig();
  });

  app.get('/api/settings/backup/repos', async (_, reply) => {
    const token = getSetting(BackupSettingKey.GithubToken);
    if (!token) {
      reply.code(400);
      return { error: 'GitHub token not configured' };
    }
    try {
      return await listUserRepos(token);
    } catch (err) {
      reply.code(502);
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Either select an existing repo or create a new one. The two paths
  // converge: write the repo full name + clone URL into app_settings
  // and return the updated config so the UI reflects the choice.
  app.post<{
    Body:
      | { mode: 'select'; fullName?: unknown; cloneUrl?: unknown }
      | { mode: 'create'; name?: unknown; private?: unknown };
  }>('/api/settings/backup/repo', async (req, reply) => {
    const token = getSetting(BackupSettingKey.GithubToken);
    if (!token) {
      reply.code(400);
      return { error: 'GitHub token not configured' };
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { error: 'expected JSON body' };
    }

    try {
      if (body.mode === 'select') {
        const fullName =
          typeof body.fullName === 'string' ? body.fullName.trim() : '';
        const cloneUrl =
          typeof body.cloneUrl === 'string' ? body.cloneUrl.trim() : '';
        if (!fullName || !cloneUrl) {
          reply.code(400);
          return { error: 'select mode requires fullName and cloneUrl' };
        }
        setSetting(BackupSettingKey.RepoFullName, fullName);
        setSetting(BackupSettingKey.RepoCloneUrl, cloneUrl);
        return readConfig();
      }
      if (body.mode === 'create') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          reply.code(400);
          return { error: 'create mode requires name' };
        }
        const repo = await createRepo(token, {
          name,
          private: body.private !== false,
        });
        setSetting(BackupSettingKey.RepoFullName, repo.fullName);
        setSetting(BackupSettingKey.RepoCloneUrl, repo.cloneUrl);
        return readConfig();
      }
      reply.code(400);
      return { error: 'mode must be "select" or "create"' };
    } catch (err) {
      if (err instanceof GithubApiError) {
        // 403 "Resource not accessible by personal access token" is the
        // commonest failure here: fine-grained PATs that lack the
        // "Administration: write" + "All repositories" combo can read
        // but not create. Surface a hint inline so the operator doesn't
        // have to dig through GitHub's docs.
        const hint =
          err.status === 403 && /personal access token/i.test(err.message)
            ? ' (the token can read repos but not create them — either reissue a classic PAT with `repo` scope, or grant Administration:write on All repositories to the fine-grained token, or create the repo on github.com and use "Select existing")'
            : '';
        reply.code(err.status >= 400 && err.status < 500 ? 400 : 502);
        return { error: err.message + hint };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Run a sync now. Single-flight inside the orchestrator so concurrent
  // POSTs collapse to one underlying export+push.
  app.post('/api/backup/sync', async (_, reply) => {
    try {
      const result = await runSync();
      return result;
    } catch (err) {
      if (err instanceof BackupError) {
        reply.code(400);
        return { error: err.message };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Pull the backup repo and merge the wiki tree into the local one.
  // Wiki files are added skip-if-exists so re-running restore is a
  // no-op and doesn't clobber in-progress local work.
  app.post('/api/backup/restore', async (_, reply) => {
    try {
      const result = await runRestore();
      return result;
    } catch (err) {
      if (err instanceof BackupError) {
        reply.code(400);
        return { error: err.message };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Database download — returns the full export as an attachment so the
  // browser drops it straight into the user's filesystem. Stable filename
  // includes the timestamp so multiple snapshots don't overwrite each
  // other in the Downloads folder.
  app.get('/api/backup/db/export', async (_, reply) => {
    const dump = buildDbExport();
    const stamp = dump.exportedAt.replace(/[:.]/g, '-');
    const filename = `pinloom-db-${stamp}.json`;
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    reply.type('application/json');
    return dump;
  });

  // Database upload — accepts a previously downloaded export and merges
  // it into the local DB. Existing project/session ids are skipped so
  // running an import twice is safe.
  app.post<{ Body: { file?: unknown } }>(
    '/api/backup/db/import',
    async (req, reply) => {
      const raw = req.body?.file;
      if (typeof raw !== 'string' || raw.length === 0) {
        reply.code(400);
        return { error: 'expected JSON body { file: "<export-contents>" }' };
      }
      try {
        const summary = importDbFile(raw);
        return summary;
      } catch (err) {
        if (err instanceof DbImportError) {
          reply.code(400);
          return { error: err.message };
        }
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
