import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { searchMessages } from '../services/message-search.js';

// GET /api/search — full-text search over conversation history (Phase 1 of
// docs/knowledge-system-v2.md). Read-only. `q` is the raw query (the service
// tokenizes + quotes it safely); optional `projectId` scopes to one project;
// optional `limit` (default 50, max 200).
export async function searchRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{
    Querystring: { q?: string; projectId?: string; limit?: string };
  }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { results: [] };
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = searchMessages(db, q, {
      projectId: req.query.projectId || undefined,
      limit,
    });
    return { results };
  });
}
