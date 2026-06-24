import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { searchMessagesHybrid } from '../services/message-search.js';
import { getEmbeddingProvider } from '../services/embeddings/index.js';

// GET /api/search — hybrid search over conversation history: lexical FTS fused
// with semantic vector KNN (knowledge-system-v2 Phase 1 + v3 §11). Read-only.
// `q` is the raw query (the service tokenizes + quotes it safely); optional
// `projectId` scopes to one project; optional `limit` (default 50, max 200).
// Degrades to FTS-only when the embedding provider isn't warm / vector extension
// is absent.
export async function searchRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{
    Querystring: { q?: string; projectId?: string; limit?: string };
  }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { results: [] };
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = await searchMessagesHybrid(
      db,
      q,
      { projectId: req.query.projectId || undefined, limit },
      getEmbeddingProvider(),
    );
    return { results };
  });
}
