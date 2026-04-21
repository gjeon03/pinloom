import type { FastifyInstance } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

interface Entry {
  name: string;
  isDir: boolean;
  hidden: boolean;
}

interface BrowseResponse {
  path: string;
  parent: string | null;
  entries: Entry[];
}

export async function fsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string; showHidden?: string } }>(
    '/api/fs/browse',
    async (req, reply) => {
      const raw = req.query.path;
      const showHidden = req.query.showHidden === 'true';

      const targetPath = raw ? resolve(raw.replace(/^~/, homedir())) : homedir();

      let stats;
      try {
        stats = await stat(targetPath);
      } catch (err) {
        reply.code(404);
        return { error: `path not found: ${targetPath}` };
      }

      if (!stats.isDirectory()) {
        reply.code(400);
        return { error: 'path is not a directory' };
      }

      let dirents;
      try {
        dirents = await readdir(targetPath, { withFileTypes: true });
      } catch (err) {
        reply.code(403);
        return {
          error: `cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const entries: Entry[] = dirents
        .map((d) => ({
          name: d.name,
          isDir: d.isDirectory() || d.isSymbolicLink(),
          hidden: d.name.startsWith('.'),
        }))
        .filter((e) => e.isDir && (showHidden || !e.hidden))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = targetPath === '/' ? null : dirname(targetPath);

      const response: BrowseResponse = {
        path: targetPath,
        parent,
        entries,
      };
      return response;
    },
  );

  app.get('/api/fs/home', async () => {
    return { home: homedir() };
  });
}
