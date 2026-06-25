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
import {
  getAnalysisStatus,
  runConventionsAnalysis,
} from '../services/wiki-analyzer.js';
import {
  exportWikiZip,
  importWikiZip,
  type ImportMode,
} from '../services/wiki-archive.js';
import { writeWikiPage, WikiWriteError } from '../services/wiki-writer.js';
import { buildWikiGraph } from '../services/wiki-graph.js';

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

  // Similarity graph (nodes = pages, edges = nearest neighbours by embedding).
  // Empty when the wiki isn't vector-indexed yet.
  app.get('/api/wiki/graph', async () => buildWikiGraph(db));

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

  // Write the page back to disk. The frontend hands us the body +
  // frontmatter fields it just edited; we re-serialise them in the
  // canonical shape so a subsequent GET returns equivalent values.
  app.put<{
    Params: { '*': string };
    Body: { meta?: unknown; body?: unknown };
  }>('/api/wiki/pages/*', async (req, reply) => {
    const filename = (req.params as { '*'?: string })['*'];
    if (!filename) {
      reply.code(400);
      return { error: 'filename is required' };
    }
    // Refuse to write a brand-new file via PUT — page creation should
    // go through the explicit "new page" flow, not a typo'd URL.
    const existing = await readWikiPage(filename);
    if (!existing) {
      reply.code(404);
      return { error: `page not found: ${filename}` };
    }
    try {
      await writeWikiPage(filename, {
        meta: req.body?.meta,
        body: req.body?.body,
      });
      const refreshed = await readWikiPage(filename);
      return refreshed;
    } catch (err) {
      if (err instanceof WikiWriteError) {
        reply.code(err.status);
        return { error: err.message };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

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

  app.post<{
    Body: {
      projectId?: string;
      dimension?: string;
      model?: string;
      startedAt?: string;
    };
  }>('/api/wiki/analyze', async (req, reply) => {
    const projectId = req.body?.projectId;
    if (!projectId || typeof projectId !== 'string') {
      reply.code(400);
      return { error: 'projectId is required' };
    }
    // dimension is reserved for future expansion (architecture, build-deploy,
    // etc.). For now we only support 'conventions'.
    const dimension = req.body?.dimension ?? 'conventions';
    if (dimension !== 'conventions') {
      reply.code(400);
      return { error: `unsupported dimension: ${dimension}` };
    }
    try {
      const result = await runConventionsAnalysis(projectId, {
        model: req.body?.model,
        startedAt: req.body?.startedAt,
      });
      return result;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Status of wiki analyses — used by the frontend to rehydrate notifications
  // after a page reload, and to poll until in-flight analyses finish.
  app.get('/api/wiki/analyses/status', async () => getAnalysisStatus());

  // Stream the entire wiki tree as a zip download.
  app.get('/api/wiki/export', async (_req, reply) => {
    const buf = await exportWikiZip();
    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="pinloom-wiki-${stamp}.zip"`,
      )
      .header('Content-Length', String(buf.length));
    return buf;
  });

  // Receive a zip via JSON+base64 (avoids adding a multipart dep). The
  // wiki is small enough for this to be fine in practice. Always creates
  // a backup zip first; never destructive without a recovery point.
  app.post<{
    Body: { mode?: ImportMode; dataBase64?: string };
  }>('/api/wiki/import', async (req, reply) => {
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'skip';
    const dataBase64 = req.body?.dataBase64;
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      reply.code(400);
      return { error: 'dataBase64 is required' };
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      reply.code(400);
      return { error: 'invalid base64' };
    }
    if (buffer.length === 0) {
      reply.code(400);
      return { error: 'empty payload' };
    }
    try {
      const summary = await importWikiZip(buffer, { mode });
      return summary;
    } catch (err) {
      reply.code(400);
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
