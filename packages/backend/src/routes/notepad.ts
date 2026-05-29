import type { FastifyInstance } from 'fastify';
import { getSetting, setSetting } from '../services/app-settings.js';

// A single global scratchpad, stored in app_settings so it rides along the
// GitHub-backed sqlite to other machines (per-project notes are a separate
// future feature). Plain text; the frontend owns rendering.
const NOTEPAD_KEY = 'notepad.content';

export async function notepadRoutes(app: FastifyInstance) {
  app.get('/api/notepad', async () => {
    return { content: getSetting(NOTEPAD_KEY) ?? '' };
  });

  app.put<{ Body: { content?: unknown } }>(
    '/api/notepad',
    async (req, reply) => {
      const content = req.body?.content;
      if (typeof content !== 'string') {
        reply.code(400);
        return { error: 'content must be a string' };
      }
      setSetting(NOTEPAD_KEY, content);
      return { ok: true as const };
    },
  );
}
