// Bot routes:
//  - POST /api/bots/:kind/open    → find-or-create the bot's singleton session
//                                    (frontend launcher), returns the Session.
//  - GET  /api/bots/dispatch/*    → HTTP surface for the pinloom MCP server in
//                                    bot mode (read-session / list-sessions),
//                                    guarded by the per-run bot token.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/connection.js';
import { ensureBotSession } from '../services/bots/host.js';
import { getBotDefinition } from '../services/bots/registry.js';
import { resolveBotSessionByToken } from '../services/bot-tokens.js';
import {
  listRecentSessions,
  readSessionTranscript,
} from '../services/session-transcript.js';
import {
  SkillError,
  listSkills,
  saveSkill,
  type SkillScope,
} from '../services/skills.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { toSession } from './sessions.js';

interface SessionRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  agent: string;
  agent_session_id: string | null;
  claude_session_id: string | null;
  title: string | null;
  next_image_number: number;
  last_synced_message_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  transport: string | null;
  bot_kind: string | null;
  created_at: string;
  updated_at: string;
}

// Coherence guard: the request must carry a currently-valid bot token (minted by
// the runner for the live bot run). Not a security boundary — single-user local
// app — it just stops stale shims from a previous backend incarnation.
//
// NOTE: this is an EXISTENCE check, not a per-session authorization. A valid
// token proves "a live bot run made this call"; it does NOT scope which session
// may be read. read-session intentionally exposes ANY session's transcript
// (that's the documented pinloom_read_session capability — the user's own bot
// summarizing the user's own history). If a future bot kind needs a narrower
// read scope, gate it here on the token's resolved sessionId, don't assume this
// guard already does.
function requireBotToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = req.headers['x-pinloom-bot-token'];
  const presented = Array.isArray(token) ? token[0] : token;
  if (!presented || !resolveBotSessionByToken(presented)) {
    reply.code(403);
    reply.send({ error: 'invalid or missing bot token' });
    return false;
  }
  return true;
}

export async function botRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post<{ Params: { kind: string } }>(
    '/api/bots/:kind/open',
    async (req, reply) => {
      const def = getBotDefinition(req.params.kind);
      if (!def) {
        reply.code(400);
        return { error: `unknown or unavailable bot: ${req.params.kind}` };
      }
      const sessionId = ensureBotSession(def.kind);
      const row = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as SessionRow;
      return toSession(row);
    },
  );

  // Reset a bot's singleton session to a clean slate: clear its messages and
  // forget the resume token so the NEXT turn starts fresh. The skill bot reuses
  // one session, so without this each new skill request inherits the prior one's
  // context. Idempotent.
  app.post<{ Params: { kind: string } }>(
    '/api/bots/:kind/reset',
    async (req, reply) => {
      const def = getBotDefinition(req.params.kind);
      if (!def) {
        reply.code(400);
        return { error: `unknown or unavailable bot: ${req.params.kind}` };
      }
      const sessionId = ensureBotSession(def.kind);
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      db.prepare(
        'UPDATE sessions SET agent_session_id = NULL, claude_session_id = NULL, updated_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), sessionId);
      const row = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as SessionRow;
      return toSession(row);
    },
  );

  app.get<{ Querystring: { sessionId?: string; limit?: string } }>(
    '/api/bots/dispatch/read-session',
    async (req, reply) => {
      if (!requireBotToken(req, reply)) return reply;
      const sessionId = req.query.sessionId;
      if (!sessionId) {
        reply.code(400);
        return { error: 'sessionId is required' };
      }
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = readSessionTranscript(sessionId, {
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      if (!result) {
        reply.code(404);
        return { error: 'session not found' };
      }
      return result;
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/bots/dispatch/list-sessions',
    async (req, reply) => {
      if (!requireBotToken(req, reply)) return reply;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return listRecentSessions({
        limit: Number.isFinite(limit) ? limit : undefined,
      });
    },
  );

  // Resolve a project selector (id | slug | name) to its cwd, excluding the
  // hidden bot host. Returns null when no visible project matches.
  function resolveProjectCwd(sel: string): string | null {
    const rows = db
      .prepare('SELECT id, name, cwd FROM projects WHERE hidden = 0')
      .all() as { id: string; name: string; cwd: string }[];
    const match =
      rows.find((p) => p.id === sel) ??
      rows.find((p) => getProjectWikiSlugByProjectId(p.id) === sel) ??
      rows.find((p) => p.name === sel);
    return match ? match.cwd : null;
  }

  app.get<{ Querystring: { scope?: string; project?: string } }>(
    '/api/bots/dispatch/list-skills',
    async (req, reply) => {
      if (!requireBotToken(req, reply)) return reply;
      const scope: SkillScope = req.query.scope === 'project' ? 'project' : 'global';
      try {
        if (scope === 'project') {
          if (!req.query.project) {
            reply.code(400);
            return { error: 'project is required for project scope' };
          }
          const cwd = resolveProjectCwd(req.query.project);
          if (!cwd) {
            reply.code(404);
            return { error: `no project matching "${req.query.project}"` };
          }
          return listSkills('project', { projectCwd: cwd });
        }
        return listSkills('global');
      } catch (err) {
        if (err instanceof SkillError) {
          reply.code(err.status);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{
    Body: {
      name?: string;
      scope?: string;
      project?: string;
      description?: string;
      body?: string;
    };
  }>('/api/bots/dispatch/save-skill', async (req, reply) => {
    if (!requireBotToken(req, reply)) return reply;
    const { name, description, body } = req.body ?? {};
    const scope: SkillScope = req.body?.scope === 'project' ? 'project' : 'global';
    if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') {
      reply.code(400);
      return { error: 'name, description, and body are required strings' };
    }
    let projectCwd: string | undefined;
    if (scope === 'project') {
      if (!req.body?.project) {
        reply.code(400);
        return { error: 'project is required for project scope' };
      }
      const cwd = resolveProjectCwd(req.body.project);
      if (!cwd) {
        reply.code(404);
        return { error: `no project matching "${req.body.project}"` };
      }
      projectCwd = cwd;
    }
    try {
      return saveSkill({ name, scope, description, body, projectCwd });
    } catch (err) {
      if (err instanceof SkillError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });
}
