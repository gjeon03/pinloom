// Work Timeline (L1) read + control API (docs/knowledge-system-v3.md §12, 2D).
// Read-only views of the per-project dated journal, a per-project auto-capture
// toggle, and a manual "capture now" trigger. The timeline ENTRIES are markdown
// files (services/timeline/store.ts); this just surfaces them. Bot↔timeline
// wiring is intentionally deferred (see §12 H1).

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { manualCaptureProjectDay } from '../services/timeline/capture.js';
import {
  assertDate,
  globalDateView,
  listDates,
  readEntry,
} from '../services/timeline/store.js';

export async function timelineRoutes(app: FastifyInstance) {
  const db = getDb();

  function projectOr404(projectId: string): { name: string; cwd: string } | null {
    return (
      (db.prepare('SELECT name, cwd FROM projects WHERE id = ?').get(projectId) as
        | { name: string; cwd: string }
        | undefined) ?? null
    );
  }

  // Dates that have a timeline entry for a project (newest first).
  app.get<{ Params: { projectId: string } }>(
    '/api/timeline/projects/:projectId',
    async (req, reply) => {
      if (!projectOr404(req.params.projectId)) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const slug = getProjectWikiSlugByProjectId(req.params.projectId);
      return { dates: listDates(slug) };
    },
  );

  // One project-day entry (markdown), or null.
  app.get<{ Params: { projectId: string; date: string } }>(
    '/api/timeline/projects/:projectId/entries/:date',
    async (req, reply) => {
      try {
        assertDate(req.params.date);
      } catch {
        reply.code(400);
        return { error: 'invalid date' };
      }
      if (!projectOr404(req.params.projectId)) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const slug = getProjectWikiSlugByProjectId(req.params.projectId);
      return { date: req.params.date, markdown: readEntry(slug, req.params.date) };
    },
  );

  // Cross-project "what did I do on D" view.
  app.get<{ Params: { date: string } }>(
    '/api/timeline/date/:date',
    async (req, reply) => {
      try {
        assertDate(req.params.date);
      } catch {
        reply.code(400);
        return { error: 'invalid date' };
      }
      // Map slug → project name (slug is id-derived; reverse via the project list).
      const projects = db
        .prepare('SELECT id, name FROM projects WHERE hidden = 0')
        .all() as { id: string; name: string }[];
      const nameBySlug = new Map(
        projects.map((p) => [getProjectWikiSlugByProjectId(p.id), p.name]),
      );
      return {
        date: req.params.date,
        entries: globalDateView(req.params.date).map((e) => ({
          slug: e.slug,
          projectName: nameBySlug.get(e.slug) ?? e.slug,
          markdown: e.markdown,
        })),
      };
    },
  );

  // Toggle per-project automatic capture.
  app.patch<{ Params: { projectId: string }; Body: { auto?: boolean } }>(
    '/api/timeline/projects/:projectId',
    async (req, reply) => {
      if (!projectOr404(req.params.projectId)) {
        reply.code(404);
        return { error: 'project not found' };
      }
      if (typeof req.body?.auto !== 'boolean') {
        reply.code(400);
        return { error: 'auto (boolean) is required' };
      }
      db.prepare('UPDATE projects SET timeline_auto = ? WHERE id = ?').run(
        req.body.auto ? 1 : 0,
        req.params.projectId,
      );
      return { ok: true as const, auto: req.body.auto };
    },
  );

  // Manual "capture now" for ALL visible projects (a given date, default today).
  // Sequential — each project is an LLM distill; the UI shows progress.
  app.post<{ Body: { date?: string } }>(
    '/api/timeline/capture-all',
    async (req, reply) => {
      const date = req.body?.date ?? localToday();
      try {
        assertDate(date);
      } catch {
        reply.code(400);
        return { error: 'invalid date' };
      }
      const projects = db
        .prepare('SELECT id FROM projects WHERE hidden = 0')
        .all() as { id: string }[];
      let captured = 0;
      for (const p of projects) {
        try {
          if (await manualCaptureProjectDay(db, p.id, date)) captured += 1;
        } catch {
          // one project's failure must not abort the rest
        }
      }
      return { ok: true as const, date, captured, projects: projects.length };
    },
  );

  // Manual "capture now" for a project + date (defaults to today, local).
  app.post<{ Params: { projectId: string }; Body: { date?: string } }>(
    '/api/timeline/projects/:projectId/capture',
    async (req, reply) => {
      if (!projectOr404(req.params.projectId)) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const date = req.body?.date ?? localToday();
      try {
        assertDate(date);
      } catch {
        reply.code(400);
        return { error: 'invalid date' };
      }
      try {
        const written = await manualCaptureProjectDay(db, req.params.projectId, date);
        return { ok: true as const, date, written };
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
