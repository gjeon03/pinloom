import type { FastifyInstance } from 'fastify';
import {
  createTerminal,
  deleteTerminal,
  listTerminals,
  renameTerminal,
  reorderTerminals,
} from '../services/terminal.js';

export async function terminalRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/terminals',
    async (req) => listTerminals(req.params.projectId),
  );

  app.post<{
    Params: { projectId: string };
    Body: { title?: string | null };
  }>('/api/projects/:projectId/terminals', async (req) =>
    createTerminal(req.params.projectId, req.body.title ?? null),
  );

  app.patch<{
    Params: { id: string };
    Body: { title?: string | null };
  }>('/api/terminals/:id', async (req, reply) => {
    const updated = renameTerminal(req.params.id, req.body.title ?? null);
    if (!updated) {
      reply.code(404);
      return { error: 'terminal not found' };
    }
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (req) => {
    const ok = deleteTerminal(req.params.id);
    return { ok };
  });

  app.post<{
    Params: { projectId: string };
    Body: { ids: string[] };
  }>('/api/projects/:projectId/terminals/reorder', async (req, reply) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      reply.code(400);
      return { error: 'ids array is required' };
    }
    return reorderTerminals(req.params.projectId, ids);
  });
}
