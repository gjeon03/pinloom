// Corpus recap API (knowledge-system-v3 Phase 4):
//  POST /api/recap/ask       {question, projectId?}              → grounded answer + sources
//  POST /api/recap/generate  {kind, dateFrom, dateTo, projectId?} → portfolio/résumé markdown
// Both run an LLM (out of process); degrade-safe (empty corpus → graceful body).

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { getEmbeddingProvider } from '../services/embeddings/index.js';
import {
  answerOverCorpus,
  generateRecap,
  type RecapKind,
} from '../services/recap.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function recapRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post<{ Body: { question?: string; projectId?: string } }>(
    '/api/recap/ask',
    async (req, reply) => {
      const question = (req.body?.question ?? '').trim();
      if (!question) {
        reply.code(400);
        return { error: 'question is required' };
      }
      try {
        return await answerOverCorpus(db, question, {
          projectId: req.body?.projectId || undefined,
          provider: getEmbeddingProvider(),
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{
    Body: { kind?: string; dateFrom?: string; dateTo?: string; projectId?: string };
  }>('/api/recap/generate', async (req, reply) => {
    const kind = req.body?.kind;
    if (kind !== 'portfolio' && kind !== 'resume') {
      reply.code(400);
      return { error: 'kind must be "portfolio" or "resume"' };
    }
    const { dateFrom, dateTo } = req.body ?? {};
    if (!dateFrom || !dateTo || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
      reply.code(400);
      return { error: 'dateFrom and dateTo (YYYY-MM-DD) are required' };
    }
    try {
      return await generateRecap(db, {
        kind: kind as RecapKind,
        dateFrom,
        dateTo,
        projectId: req.body?.projectId || undefined,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
