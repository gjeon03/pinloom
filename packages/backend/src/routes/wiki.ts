import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import {
  getWikiOverview,
  getWikiRoot,
  readWikiPage,
  resolveAbsolutePageFile,
} from '../services/wiki-reader.js';

interface SessionRow {
  id: string;
  project_id: string;
  title: string | null;
  last_synced_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionWithProject extends SessionRow {
  project_name: string | null;
  project_cwd: string;
}

function openExternal(filePath: string): { ok: boolean; error?: string } {
  // macOS-only for now: `open` launches the file in the user's default
  // handler. Linux/Windows users can fall back to the manual path shown
  // in the UI.
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: `Auto-open is only supported on macOS for now. Path: ${filePath}`,
    };
  }
  try {
    const child = spawn('open', [filePath], { stdio: 'ignore', detached: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/wiki/overview', async () => {
    const overview = await getWikiOverview();
    return overview;
  });

  app.get<{ Params: { '*': string } }>(
    '/api/wiki/pages/*',
    async (req, reply) => {
      const filename = (req.params as { '*'?: string })['*'];
      if (!filename) {
        reply.code(400);
        return { error: 'filename is required' };
      }
      const page = await readWikiPage(filename);
      if (!page) {
        reply.code(404);
        return { error: `page not found: ${filename}` };
      }
      return page;
    },
  );

  app.post<{ Body: { filename?: string } }>('/api/wiki/open', async (req, reply) => {
    const filename = req.body?.filename;
    if (!filename) {
      reply.code(400);
      return { error: 'filename is required' };
    }
    const full = resolveAbsolutePageFile(filename);
    if (!full) {
      reply.code(400);
      return { error: 'invalid filename' };
    }
    const result = openExternal(full);
    if (!result.ok) {
      reply.code(500);
      return { error: result.error ?? 'open failed' };
    }
    return { ok: true, path: full };
  });

  app.post('/api/wiki/open-folder', async (_req, reply) => {
    const result = openExternal(getWikiRoot());
    if (!result.ok) {
      reply.code(500);
      return { error: result.error ?? 'open failed' };
    }
    return { ok: true, path: getWikiRoot() };
  });

  // List sessions across all projects, newest first — used by the wiki
  // dashboard's "Sync from session" picker. Includes project context plus
  // a flag indicating whether the session has unsynced messages.
  app.get('/api/wiki/sync-candidates', async () => {
    const sessions = db
      .prepare(
        `SELECT s.id, s.project_id, s.title, s.last_synced_message_id,
                s.created_at, s.updated_at,
                p.name AS project_name, p.cwd AS project_cwd
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.hidden = 0
         ORDER BY s.updated_at DESC
         LIMIT 100`,
      )
      .all() as SessionWithProject[];

    const result = sessions.map((s) => {
      let unsyncedCount = 0;
      if (s.last_synced_message_id) {
        const cutoff = db
          .prepare('SELECT created_at FROM messages WHERE id = ?')
          .get(s.last_synced_message_id) as { created_at: string } | undefined;
        if (cutoff) {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n
               FROM messages
               WHERE session_id = ?
                     AND source_message_id IS NULL
                     AND role IN ('user', 'assistant')
                     AND created_at > ?`,
            )
            .get(s.id, cutoff.created_at) as { n: number } | undefined;
          unsyncedCount = row?.n ?? 0;
        }
      } else {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM messages
             WHERE session_id = ?
                   AND source_message_id IS NULL
                   AND role IN ('user', 'assistant')`,
          )
          .get(s.id) as { n: number } | undefined;
        unsyncedCount = row?.n ?? 0;
      }
      return {
        id: s.id,
        projectId: s.project_id,
        projectName: s.project_name,
        projectCwd: s.project_cwd,
        projectBasename: path.basename(s.project_cwd),
        title: s.title,
        lastSyncedMessageId: s.last_synced_message_id,
        unsyncedCount,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      };
    });

    return result;
  });
}
