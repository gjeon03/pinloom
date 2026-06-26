// Work Timeline (L1) read + control API (docs/knowledge-system-v3.md §12, 2D).
// Read-only views of the per-project dated journal, a per-project auto-capture
// toggle, and a manual "capture now" trigger. The timeline ENTRIES are markdown
// files (services/timeline/store.ts); this just surfaces them. Bot↔timeline
// wiring is intentionally deferred (see §12 H1).

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { manualCaptureProjectDay } from '../services/timeline/capture.js';
import { openExternal } from '../services/open-external.js';
import {
  assertDate,
  entryPath,
  globalDateView,
  listDates,
  readEntry,
  writeEntry,
} from '../services/timeline/store.js';

interface CaptureAllJob {
  running: boolean;
  date: string;
  total: number;
  done: number;
  captured: number;
  failed: number;
  finishedAt: number | null;
}
// In-process tracker for the background "capture all" job (one at a time).
let captureAllJob: CaptureAllJob = {
  running: false,
  date: '',
  total: 0,
  done: 0,
  captured: 0,
  failed: 0,
  finishedAt: null,
};

export async function timelineRoutes(app: FastifyInstance) {
  const db = getDb();

  function projectOr404(projectId: string): { name: string; cwd: string } | null {
    return (
      (db.prepare('SELECT name, cwd FROM projects WHERE id = ?').get(projectId) as
        | { name: string; cwd: string }
        | undefined) ?? null
    );
  }

  // Tree index for the "By project" sidebar: every visible project with its
  // auto flag + the dates it has entries for (newest first). One call powers
  // the Finder-style project→date tree.
  app.get('/api/timeline/index', async () => {
    const projects = db
      .prepare('SELECT id, name, timeline_auto FROM projects WHERE hidden = 0 ORDER BY name')
      .all() as { id: string; name: string; timeline_auto: number }[];
    return {
      projects: projects.map((p) => ({
        projectId: p.id,
        projectName: p.name,
        auto: p.timeline_auto !== 0,
        dates: listDates(getProjectWikiSlugByProjectId(p.id)),
      })),
    };
  });

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

  // Save an edited entry in place (the timeline is the user's to curate — same
  // as the wiki's edit-in-place). Empty body deletes nothing; we just write what
  // the user kept. assertDate guards the path.
  app.put<{ Params: { projectId: string; date: string }; Body: { markdown?: string } }>(
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
      if (typeof req.body?.markdown !== 'string') {
        reply.code(400);
        return { error: 'markdown (string) is required' };
      }
      const slug = getProjectWikiSlugByProjectId(req.params.projectId);
      writeEntry(slug, req.params.date, req.body.markdown);
      return { ok: true as const, date: req.params.date };
    },
  );

  // Reveal the entry's markdown file in Finder (open its folder, file selected).
  app.post<{ Params: { projectId: string; date: string } }>(
    '/api/timeline/projects/:projectId/entries/:date/open',
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
      if (readEntry(slug, req.params.date) === null) {
        reply.code(404);
        return { error: 'no entry for this day yet' };
      }
      const full = entryPath(slug, req.params.date);
      const result = openExternal(full, { reveal: true });
      if (!result.ok) {
        reply.code(500);
        return { error: result.error ?? 'open failed' };
      }
      return { ok: true as const, path: full };
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

  // "Capture all" runs N sequential LLM distills (minutes). Rather than block one
  // long request — whose UI state dies the moment the user navigates away — it
  // runs as a background job tracked in-process, and the client polls
  // /capture-all/status. State thus survives navigation AND reload (the backend
  // owns it); a backend restart resets it to not-running (the job died with it).
  app.get('/api/timeline/capture-all/status', async () => captureAllJob);

  app.post<{ Body: { date?: string } }>(
    '/api/timeline/capture-all',
    async (req, reply) => {
      if (captureAllJob.running) {
        reply.code(409);
        return { error: 'capture already running', job: captureAllJob };
      }
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
      captureAllJob = {
        running: true,
        date,
        total: projects.length,
        done: 0,
        captured: 0,
        failed: 0,
        finishedAt: null,
      };
      // Fire-and-forget: keep the event loop going after the response is sent.
      void (async () => {
        for (const p of projects) {
          try {
            if (await manualCaptureProjectDay(db, p.id, date)) captureAllJob.captured += 1;
          } catch {
            captureAllJob.failed += 1; // one project's failure must not abort the rest
          }
          captureAllJob.done += 1;
        }
        captureAllJob.running = false;
        captureAllJob.finishedAt = Date.now();
      })();
      return { started: true as const, date, total: projects.length };
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
