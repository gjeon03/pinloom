// Opt-in static serving of the built frontend from the backend itself, so a
// single server (the backend port) serves BOTH the API/WS and the SPA. This is
// what the desktop app's bundled sidecar uses: one origin, no Vite dev server.
//
// Dev/prod-via-launchd are UNAFFECTED — this only registers when
// PINLOOM_SERVE_STATIC=1. In dev the Vite dev server (4747) proxies /api to the
// backend (4748) as before; here the relationship is inverted (backend owns the
// origin and the frontend's relative `/api` + `location.host` WS URLs resolve
// same-origin).
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const HERE = dirname(fileURLToPath(import.meta.url));

// Where the built frontend lives. The packaged app sets PINLOOM_STATIC_DIR
// explicitly (electron-builder copies frontend/dist into the app resources);
// otherwise fall back to the monorepo layout (works whether the backend runs
// from src/ via tsx or from dist/ — both sit one level under packages/backend).
export function resolveStaticDir(): string {
  if (process.env.PINLOOM_STATIC_DIR) {
    return resolve(process.env.PINLOOM_STATIC_DIR);
  }
  return resolve(HERE, '../../frontend/dist');
}

export function shouldServeStatic(): boolean {
  return process.env.PINLOOM_SERVE_STATIC === '1';
}

export async function registerStaticFrontend(app: FastifyInstance): Promise<void> {
  const root = resolveStaticDir();
  if (!existsSync(resolve(root, 'index.html'))) {
    app.log.warn(
      `[static] PINLOOM_SERVE_STATIC=1 but no built frontend at ${root} ` +
        '(run `pnpm --filter @pinloom/frontend build`) — serving API only',
    );
    return;
  }

  // Serve hashed assets with a long cache; index.html stays uncached so a new
  // build's asset hashes are picked up on next load. `wildcard: false` lets the
  // notFoundHandler below own SPA fallback instead of @fastify/static globbing,
  // and `index: false` routes the bare `/` through that same fallback so EVERY
  // index.html send (root + deep links) goes through one no-cache path —
  // otherwise the directory-index send is keyed on the dir, not the file, and
  // setHeaders' `endsWith('index.html')` check misses it.
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders(res, filePath) {
      // Vite emits content-hashed files under assets/ — safe to cache forever.
      // Everything else (index.html, sw.js, manifest) must stay fresh so a new
      // build is picked up on next load.
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  });

  // SPA fallback: react-router uses BrowserRouter with deep paths
  // (`/session/:id`), so a hard reload or deep link hits the backend with a
  // non-file path. Serve index.html for those — but NEVER for /api or /ws
  // (those must keep their real 404, not silently return the app shell) and
  // only for GET/HEAD (a stray POST to a wrong path should 404, not get HTML).
  app.setNotFoundHandler((req, reply) => {
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api') &&
      !req.url.startsWith('/ws')
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  app.log.info(`[static] serving frontend from ${root}`);
}
