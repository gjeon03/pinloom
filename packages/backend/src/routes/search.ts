import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { searchMessagesHybrid } from '../services/message-search.js';
import { searchTimeline } from '../services/timeline/search.js';
import { searchWiki } from '../services/wiki-search.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { getEmbeddingProvider } from '../services/embeddings/index.js';

// Resolve a group filter to the projects it scopes to. '__ungrouped__' targets
// projects with no group. Returns null when no group filter (= all projects).
export function resolveGroupProjects(
  db: Database.Database,
  groupId: string | undefined,
): { projectIds: string[]; projectSlugs: string[] } | null {
  if (!groupId) return null;
  const rows = (
    groupId === '__ungrouped__'
      ? db.prepare('SELECT id FROM projects WHERE group_id IS NULL AND hidden = 0').all()
      : db.prepare('SELECT id FROM projects WHERE group_id = ? AND hidden = 0').all(groupId)
  ) as { id: string }[];
  const projectIds = rows.map((r) => r.id);
  return {
    projectIds,
    projectSlugs: projectIds.map((id) => getProjectWikiSlugByProjectId(id)),
  };
}

// GET /api/search — hybrid search over conversation history: lexical FTS fused
// with semantic vector KNN (knowledge-system-v2 Phase 1 + v3 §11). Read-only.
// `q` is the raw query (the service tokenizes + quotes it safely); optional
// `projectId` scopes to one project; optional `limit` (default 50, max 200).
// Degrades to FTS-only when the embedding provider isn't warm / vector extension
// is absent.
export async function searchRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{
    Querystring: { q?: string; projectId?: string; groupId?: string; limit?: string };
  }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { results: [], timeline: [], wiki: [] };
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const projectId = req.query.projectId || undefined;
    const group = resolveGroupProjects(db, req.query.groupId || undefined);
    // A group with zero projects scopes to nothing — don't fall through to "all".
    if (group && group.projectIds.length === 0) return { results: [], timeline: [], wiki: [] };
    const projectIds = group?.projectIds;
    const provider = getEmbeddingProvider();
    const [results, timeline, wiki] = await Promise.all([
      searchMessagesHybrid(db, q, { projectId, projectIds, limit }, provider),
      searchTimeline(db, q, { projectId, projectIds, limit }, provider),
      searchWiki(db, q, { limit, projectSlugs: group?.projectSlugs }, provider),
    ]);
    return { results, timeline, wiki };
  });
}
