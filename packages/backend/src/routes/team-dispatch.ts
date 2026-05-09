// HTTP surface consumed by the pinloom MCP server (`packages/mcp-server`)
// when an orchestrator agent dispatches work to its team's worker
// sessions. Routes are scoped under `/api/teams/:teamId/dispatch/*` and
// authenticated by the `X-Pinloom-Team-Token` header — the token is
// minted in-memory at orchestrator-spawn time (services/team-tokens.ts)
// and dies with the backend, so a stale shim from a previous run can't
// keep dispatching after the user has moved on.
//
// Five tools live here, mirroring the MCP shim's surface:
//   GET  /list                                    — team_list
//   POST /send       {alias, text}                — team_send
//   GET  /messages   ?alias=&sinceMessageId=      — team_read
//   GET  /status     ?alias=                      — team_status
//   GET  /wait       ?alias=&timeoutMs=           — team_wait (long-poll)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { getMemberByAlias, getTeam } from '../services/teams.js';
import {
  enqueueMessage,
  InvalidQueueContentError,
  listQueueItems,
  SessionNotFoundError,
} from '../services/message-queue.js';
import { isAiRunning, tryDrainQueue, waitForIdle } from '../services/runner.js';
import { resolveTeamByToken } from '../services/team-tokens.js';

interface SessionRow {
  id: string;
  project_id: string;
  agent: 'claude' | 'codex' | null;
}

// Hard cap so a buggy MCP client can't pin a connection open for hours.
const MAX_WAIT_MS = 60_000;

function authorize(req: FastifyRequest, reply: FastifyReply): string | null {
  const presented = req.headers['x-pinloom-team-token'];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (typeof token !== 'string' || token.length === 0) {
    reply.code(401);
    reply.send({ error: 'missing X-Pinloom-Team-Token header' });
    return null;
  }
  const params = req.params as { teamId: string };
  const resolvedTeamId = resolveTeamByToken(token);
  if (!resolvedTeamId || resolvedTeamId !== params.teamId) {
    reply.code(403);
    reply.send({ error: 'invalid or revoked team token' });
    return null;
  }
  return resolvedTeamId;
}

interface DispatchMember {
  alias: string;
  agent: 'claude' | 'codex';
  /** Last model the worker actually responded with, if any. We surface
   *  the most recent value because pinloom's `model` is per-message
   *  (each turn can use a different one), not a session-level default. */
  lastModel: string | null;
  projectName: string | null;
  status: 'idle' | 'running' | 'queued' | 'mixed';
  queued: number;
}

function memberStatus(sessionId: string): DispatchMember['status'] {
  const running = isAiRunning(sessionId);
  const queued = listQueueItems(sessionId).length;
  if (running && queued > 0) return 'mixed';
  if (running) return 'running';
  if (queued > 0) return 'queued';
  return 'idle';
}

export async function teamDispatchRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { teamId: string } }>(
    '/api/teams/:teamId/dispatch/list',
    async (req, reply) => {
      if (!authorize(req, reply)) return;
      const team = getTeam(req.params.teamId);
      if (!team) {
        reply.code(404);
        return { error: 'team not found' };
      }
      const result: DispatchMember[] = [];
      for (const m of team.members) {
        const session = db
          .prepare(
            'SELECT id, project_id, agent FROM sessions WHERE id = ?',
          )
          .get(m.sessionId) as SessionRow | undefined;
        if (!session) continue;
        const project = db
          .prepare('SELECT name FROM projects WHERE id = ?')
          .get(session.project_id) as { name: string } | undefined;
        const lastModelRow = db
          .prepare(
            `SELECT model FROM messages
             WHERE session_id = ? AND model IS NOT NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(m.sessionId) as { model: string | null } | undefined;
        result.push({
          alias: m.alias,
          agent: session.agent ?? 'claude',
          lastModel: lastModelRow?.model ?? null,
          projectName: project?.name ?? null,
          status: memberStatus(m.sessionId),
          queued: listQueueItems(m.sessionId).length,
        });
      }
      return result;
    },
  );

  app.post<{
    Params: { teamId: string };
    Body: { alias?: string; text?: string };
  }>('/api/teams/:teamId/dispatch/send', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const alias = req.body?.alias?.trim();
    const text = req.body?.text;
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    if (typeof text !== 'string' || text.length === 0) {
      reply.code(400);
      return { error: 'text is required' };
    }
    const member = getMemberByAlias(req.params.teamId, alias);
    if (!member) {
      reply.code(404);
      return { error: `no worker with alias "${alias}" in this team` };
    }
    try {
      const item = enqueueMessage({ sessionId: member.sessionId, content: text });
      // Worker session may be idle — kick off a drain so the dispatched
      // prompt actually reaches its agent instead of sitting in the queue
      // until the worker happens to receive its next user message.
      tryDrainQueue(member.sessionId);
      return { ok: true, queueItemId: item.id };
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof InvalidQueueContentError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get<{
    Params: { teamId: string };
    Querystring: { alias?: string; sinceMessageId?: string; limit?: string };
  }>('/api/teams/:teamId/dispatch/messages', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const alias = req.query.alias?.trim();
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    const member = getMemberByAlias(req.params.teamId, alias);
    if (!member) {
      reply.code(404);
      return { error: `no worker with alias "${alias}" in this team` };
    }
    const requestedLimit = Number(req.query.limit ?? '20');
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
      : 20;
    let baseSql =
      "SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant')";
    const sqlArgs: Array<string | number> = [member.sessionId];
    if (req.query.sinceMessageId) {
      // "messages newer than X" is implemented by created_at because
      // the messages table uses ISO timestamps and string-collation
      // ordering matches lexicographic ISO sort. Scope the lookup to
      // the same session so a confused caller can't probe across
      // sessions by trying random ids.
      const sinceRow = db
        .prepare(
          'SELECT created_at FROM messages WHERE id = ? AND session_id = ?',
        )
        .get(req.query.sinceMessageId, member.sessionId) as
        | { created_at: string }
        | undefined;
      if (!sinceRow) {
        reply.code(404);
        return {
          error: `sinceMessageId not found in worker @${alias}'s history`,
        };
      }
      baseSql += ' AND created_at > ?';
      sqlArgs.push(sinceRow.created_at);
    }
    baseSql += ' ORDER BY created_at ASC, id ASC LIMIT ?';
    sqlArgs.push(limit);
    const rows = db.prepare(baseSql).all(...sqlArgs) as Array<{
      id: string;
      role: string;
      content: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  });

  app.get<{
    Params: { teamId: string };
    Querystring: { alias?: string };
  }>('/api/teams/:teamId/dispatch/status', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const alias = req.query.alias?.trim();
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    const member = getMemberByAlias(req.params.teamId, alias);
    if (!member) {
      reply.code(404);
      return { error: `no worker with alias "${alias}" in this team` };
    }
    return {
      running: isAiRunning(member.sessionId),
      queued: listQueueItems(member.sessionId).length,
    };
  });

  app.get<{
    Params: { teamId: string };
    Querystring: { alias?: string; timeoutMs?: string };
  }>('/api/teams/:teamId/dispatch/wait', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const alias = req.query.alias?.trim();
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    const member = getMemberByAlias(req.params.teamId, alias);
    if (!member) {
      reply.code(404);
      return { error: `no worker with alias "${alias}" in this team` };
    }
    const requested = parseInt(req.query.timeoutMs ?? '60000', 10) || 60_000;
    const timeoutMs = Math.min(Math.max(requested, 100), MAX_WAIT_MS);

    // Tie the wait to the underlying socket so a disconnected MCP shim
    // doesn't pin the worker thread hostage until timeout. Detach after
    // resolution so the AbortController doesn't outlive the request.
    const ac = new AbortController();
    const onSocketClose = () => ac.abort();
    req.raw.once('close', onSocketClose);
    try {
      const idle = await waitForIdle(member.sessionId, timeoutMs, ac.signal);
      return {
        idle,
        queued: listQueueItems(member.sessionId).length,
      };
    } finally {
      req.raw.off('close', onSocketClose);
    }
  });
}
