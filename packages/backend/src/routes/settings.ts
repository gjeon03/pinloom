import type { FastifyInstance } from 'fastify';
import {
  deleteUserEnvVar,
  getUserEnvVar,
  isValidKey,
  listUserEnvVars,
  upsertUserEnvVar,
} from '../services/user-env.js';
import { getSetting, setSetting, deleteSetting } from '../services/app-settings.js';
import {
  claudeTransport,
  DEFAULT_TRANSPORT_KEY,
} from '../services/agents/index.js';
import {
  AutostartNotBuiltError,
  AutostartUnsupportedError,
  disableAutostart,
  enableAutostart,
  generateAutostartUnit,
  getAutostartStatus,
} from '../services/autostart.js';
import { embeddingsStatus } from '../services/embeddings/index.js';

export async function settingsRoutes(app: FastifyInstance) {
  // Which embedding backend powers semantic search (in-process default / Ollama
  // / off) and whether it's warmed up. Selected at boot via PINLOOM_EMBEDDINGS.
  app.get('/api/settings/embeddings', async () => embeddingsStatus());

  // Default transport for NEW sessions. `effective` is what claudeTransport()
  // currently resolves to (setting → env → 'sdk'); `setting` is the explicit
  // user choice (null = follow env/default). Only sdk|terminal are user-
  // selectable; 'pty' stays an env-only/billing concern.
  app.get('/api/settings/default-transport', async () => {
    const setting = getSetting(DEFAULT_TRANSPORT_KEY);
    return { setting, effective: claudeTransport() };
  });

  app.put<{ Body: { transport?: string | null } }>(
    '/api/settings/default-transport',
    async (req, reply) => {
      const t = req.body?.transport;
      if (t === null || t === undefined || t === '') {
        deleteSetting(DEFAULT_TRANSPORT_KEY); // clear → follow env/default
        return { setting: null, effective: claudeTransport() };
      }
      if (t !== 'sdk' && t !== 'terminal') {
        reply.code(400);
        return { error: "transport must be 'sdk' or 'terminal'" };
      }
      setSetting(DEFAULT_TRANSPORT_KEY, t);
      return { setting: t, effective: claudeTransport() };
    },
  );

  // Login autostart (macOS LaunchAgent / Linux systemd --user). The OS is the
  // source of truth — every GET re-reads the unit file + queries the loader,
  // because the user can unload it out-of-band. See services/autostart.ts.
  app.get('/api/settings/autostart', async () => {
    return getAutostartStatus();
  });

  app.post('/api/settings/autostart', async (_req, reply) => {
    try {
      return await enableAutostart();
    } catch (err) {
      if (err instanceof AutostartUnsupportedError) {
        reply.code(501);
        return { error: err.message };
      }
      if (err instanceof AutostartNotBuiltError) {
        reply.code(409);
        return { error: err.message };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/api/settings/autostart', async (_req, reply) => {
    try {
      return await disableAutostart();
    } catch (err) {
      if (err instanceof AutostartUnsupportedError) {
        reply.code(501);
        return { error: err.message };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // The generated unit file as a download — the manual fallback for
  // unsupported platforms (Windows) or users who prefer to install it
  // themselves. Returns 501 when the current platform has no unit format.
  app.get('/api/settings/autostart/unit', async (_req, reply) => {
    const unit = generateAutostartUnit();
    if (!unit) {
      reply.code(501);
      return { error: 'No autostart unit format for this platform.' };
    }
    const filename = unit.path.split('/').pop() ?? 'pinloom-autostart';
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`);
    return unit.content;
  });

  app.get('/api/settings/env', async () => {
    return listUserEnvVars();
  });

  // Lookup with the raw value. Used by the edit modal's "show current value"
  // flow only; the list endpoint deliberately omits the value to keep masked
  // secrets off the wire when not needed.
  app.get<{ Params: { key: string } }>(
    '/api/settings/env/:key',
    async (req, reply) => {
      const found = getUserEnvVar(req.params.key);
      if (!found) {
        reply.code(404);
        return { error: 'not found' };
      }
      return found;
    },
  );

  app.put<{
    Params: { key: string };
    Body: { value: string; description?: string | null; isSecret?: boolean };
  }>('/api/settings/env/:key', async (req, reply) => {
    const { key } = req.params;
    if (!isValidKey(key)) {
      reply.code(400);
      return { error: 'invalid key — must match /^[A-Za-z_][A-Za-z0-9_]*$/' };
    }
    const { value, description, isSecret } = req.body ?? {};
    if (typeof value !== 'string' || value.length === 0) {
      reply.code(400);
      return { error: 'value must be a non-empty string' };
    }
    try {
      return upsertUserEnvVar({ key, value, description, isSecret });
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete<{ Params: { key: string } }>(
    '/api/settings/env/:key',
    async (req, reply) => {
      const removed = deleteUserEnvVar(req.params.key);
      if (!removed) {
        reply.code(404);
        return { error: 'not found' };
      }
      return { ok: true as const };
    },
  );
}
