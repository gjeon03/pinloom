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
import { resolveGroupProjects } from './search.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function recapRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post<{
    Body: { question?: string; projectId?: string; groupId?: string; language?: string };
  }>(
    '/api/recap/ask',
    async (req, reply) => {
      const question = (req.body?.question ?? '').trim();
      if (!question) {
        reply.code(400);
        return { error: 'question is required' };
      }
      const group = resolveGroupProjects(db, req.body?.groupId || undefined);
      if (group && group.projectIds.length === 0) {
        return { answer: '이 그룹에 자료가 없어요.', sources: [] };
      }
      try {
        return await answerOverCorpus(db, question, {
          projectId: req.body?.projectId || undefined,
          projectIds: group?.projectIds,
          projectSlugs: group?.projectSlugs,
          provider: getEmbeddingProvider(),
          language: req.body?.language === 'en' ? 'en' : 'ko',
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{
    Body: {
      kind?: string;
      dateFrom?: string;
      dateTo?: string;
      projectId?: string;
      language?: string;
    };
  }>('/api/recap/generate', async (req, reply) => {
    const kind = req.body?.kind;
    if (kind !== 'detailed' && kind !== 'concise') {
      reply.code(400);
      return { error: 'kind must be "detailed" or "concise"' };
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
        language: req.body?.language === 'en' ? 'en' : 'ko',
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
