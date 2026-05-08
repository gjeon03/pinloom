import type { FastifyInstance } from 'fastify';
import {
  deleteUserEnvVar,
  getUserEnvVar,
  isValidKey,
  listUserEnvVars,
  upsertUserEnvVar,
} from '../services/user-env.js';

export async function settingsRoutes(app: FastifyInstance) {
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
