// General (non-bot) Skills API for the management page. The skill BOT writes
// skills via /api/bots/dispatch/* (bot-token gated); this exposes the same
// store for a human to browse / edit / delete / repair links directly. Skills
// are a single source (~/.pinloom/skills, symlinked into ~/.claude + ~/.codex)
// or project-scoped (<cwd>/.claude/skills) — see services/skills.ts.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../db/connection.js';
import {
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  relinkGlobalSkill,
  SkillError,
  type SkillScope,
  type SkillSummary,
} from '../services/skills.js';
import { getSkillUsage } from '../services/skill-usage.js';

// Merge fun usage stats (count / lastUsedAt) into a skill or skill list.
function withUsage<T extends SkillSummary>(skills: T[]): T[] {
  const usage = getSkillUsage();
  return skills.map((s) => {
    const u = usage.get(s.name);
    return { ...s, useCount: u?.count ?? 0, lastUsedAt: u?.lastUsedAt ?? null };
  });
}

function asScope(v: unknown): SkillScope {
  return v === 'project' ? 'project' : 'global';
}

function projectCwdById(id: string): string | null {
  const row = getDb()
    .prepare('SELECT cwd FROM projects WHERE id = ?')
    .get(id) as { cwd: string } | undefined;
  return row?.cwd ?? null;
}

// Map a thrown SkillError → its status; rethrow anything else.
function fail(reply: FastifyReply, err: unknown): { error: string } {
  if (err instanceof SkillError) {
    reply.code(err.status);
    return { error: err.message };
  }
  throw err;
}

export async function skillRoutes(app: FastifyInstance) {
  // List skills in a scope. project scope needs ?project=<id>.
  app.get<{ Querystring: { scope?: string; project?: string } }>(
    '/api/skills',
    async (req, reply) => {
      const scope = asScope(req.query.scope);
      try {
        if (scope === 'project') {
          const cwd = req.query.project ? projectCwdById(req.query.project) : null;
          if (!cwd) {
            reply.code(400);
            return { error: 'project scope requires a valid ?project=<id>' };
          }
          return withUsage(listSkills('project', { projectCwd: cwd }));
        }
        return withUsage(listSkills('global'));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Read one skill's full content (description + editable body).
  app.get<{ Params: { scope: string; name: string }; Querystring: { project?: string } }>(
    '/api/skills/:scope/:name',
    async (req, reply) => {
      const scope = asScope(req.params.scope);
      try {
        const projectCwd =
          scope === 'project'
            ? (req.query.project && projectCwdById(req.query.project)) || undefined
            : undefined;
        if (scope === 'project' && !projectCwd) {
          reply.code(400);
          return { error: 'project scope requires a valid ?project=<id>' };
        }
        return withUsage([readSkill(scope, req.params.name, { projectCwd })])[0];
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Create or update a skill (relinks claude/codex for global). Mirrors the bot
  // save path but for the human-driven editor.
  app.put<{
    Body: { name?: string; scope?: string; description?: string; body?: string; project?: string };
  }>('/api/skills', async (req, reply) => {
    const { name, description, body } = req.body ?? {};
    const scope = asScope(req.body?.scope);
    if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') {
      reply.code(400);
      return { error: 'name, description, and body are required strings' };
    }
    let projectCwd: string | undefined;
    if (scope === 'project') {
      const cwd = req.body?.project ? projectCwdById(req.body.project) : null;
      if (!cwd) {
        reply.code(400);
        return { error: 'project scope requires a valid project id' };
      }
      projectCwd = cwd;
    }
    try {
      return saveSkill({ name, scope, description, body, projectCwd });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Delete a skill (global: removes source + our symlinks; project: removes dir).
  app.delete<{ Params: { scope: string; name: string }; Querystring: { project?: string } }>(
    '/api/skills/:scope/:name',
    async (req, reply) => {
      const scope = asScope(req.params.scope);
      try {
        const projectCwd =
          scope === 'project'
            ? (req.query.project && projectCwdById(req.query.project)) || undefined
            : undefined;
        if (scope === 'project' && !projectCwd) {
          reply.code(400);
          return { error: 'project scope requires a valid ?project=<id>' };
        }
        deleteSkill(scope, req.params.name, { projectCwd });
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Repair a global skill's claude/codex symlinks.
  app.post<{ Params: { name: string } }>(
    '/api/skills/:name/relink',
    async (req, reply) => {
      try {
        return { links: relinkGlobalSkill(req.params.name) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
