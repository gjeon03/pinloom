import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  addMember,
  AliasTakenError,
  createTeam,
  deleteTeam,
  getTeam,
  InstructionsTooLongError,
  InvalidAliasError,
  InvalidTagError,
  listTeams,
  OrchestratorWorkerConflictError,
  removeMember,
  SessionAlreadyInTeamError,
  SessionNotFoundError,
  TeamNotFoundError,
  TooManyTagsError,
  updateMember,
  updateTeam,
} from '../services/teams.js';
import { getDb } from '../db/connection.js';
import { hasAgentTerminal, killAgentTerminal } from '../services/claude-pty/agent-terminal.js';
import { hasCodexTerminal, killCodexTerminal } from '../services/codex-pty/agent-terminal.js';
import { broadcast } from '../ws/hub.js';

// A live terminal session that just became a team's orchestrator was launched
// WITHOUT the pinloom MCP config (it's only added for orchestrators, at launch).
// Kill its agent so AgentTerminal re-attaches and respawns WITH the MCP server —
// otherwise the team_* tools don't appear until a manual session/server restart.
// Handles both terminal agents (claude + codex) so an already-live codex
// orchestrator picks up its MCP tools exactly like claude. No-op for
// sdk/structured sessions and for sessions with no live terminal (their next
// launch already picks up the orchestrator config).
function relaunchOrchestratorTerminal(sessionId: string): void {
  const row = getDb()
    .prepare('SELECT transport, agent FROM sessions WHERE id = ?')
    .get(sessionId) as { transport: string | null; agent: string | null } | undefined;
  if (row?.transport !== 'terminal') return;
  if (row.agent === 'codex') {
    if (!hasCodexTerminal(sessionId)) return;
    killCodexTerminal(sessionId);
  } else {
    if (!hasAgentTerminal(sessionId)) return;
    killAgentTerminal(sessionId);
  }
  broadcast(`session:${sessionId}`, { type: 'terminal_relaunch', sessionId });
}

// Maps service-layer typed errors to HTTP status codes the frontend can
// branch on. Anything else falls through to 500 via re-throw.
function replyForError(reply: FastifyReply, err: unknown): { error: string } {
  if (err instanceof TeamNotFoundError || err instanceof SessionNotFoundError) {
    reply.code(404);
    return { error: err.message };
  }
  if (
    err instanceof InvalidAliasError ||
    err instanceof InvalidTagError ||
    err instanceof TooManyTagsError ||
    err instanceof InstructionsTooLongError
  ) {
    reply.code(400);
    return { error: err.message };
  }
  if (
    err instanceof AliasTakenError ||
    err instanceof SessionAlreadyInTeamError ||
    err instanceof OrchestratorWorkerConflictError
  ) {
    reply.code(409);
    return { error: err.message };
  }
  throw err;
}

export async function teamRoutes(app: FastifyInstance) {
  app.get('/api/teams', async () => listTeams());

  app.get<{ Params: { id: string } }>('/api/teams/:id', async (req, reply) => {
    const team = getTeam(req.params.id);
    if (!team) {
      reply.code(404);
      return { error: 'team not found' };
    }
    return team;
  });

  app.post<{
    Body: {
      name?: string;
      orchestratorSessionId?: string;
      instructions?: string | null;
    };
  }>('/api/teams', async (req, reply) => {
    const name = req.body?.name?.trim();
    const orchestratorSessionId = req.body?.orchestratorSessionId?.trim();
    if (!name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    if (!orchestratorSessionId) {
      reply.code(400);
      return { error: 'orchestratorSessionId is required' };
    }
    try {
      const team = createTeam({
        name,
        orchestratorSessionId,
        instructions: req.body?.instructions ?? null,
      });
      relaunchOrchestratorTerminal(orchestratorSessionId);
      return team;
    } catch (err) {
      return replyForError(reply, err);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      orchestratorSessionId?: string;
      instructions?: string | null;
    };
  }>('/api/teams/:id', async (req, reply) => {
    const name = req.body?.name?.trim();
    const orchestratorSessionId = req.body?.orchestratorSessionId?.trim();
    if (name !== undefined && name.length === 0) {
      reply.code(400);
      return { error: 'name cannot be empty' };
    }
    if (
      req.body?.orchestratorSessionId !== undefined &&
      !orchestratorSessionId
    ) {
      reply.code(400);
      return { error: 'orchestratorSessionId cannot be empty' };
    }
    // Same partial-update semantics as the member PATCH: omit a key to
    // leave alone, pass `null` to clear.
    const body = req.body ?? {};
    const instructionsProvided = 'instructions' in body;
    const priorOrchestrator = getTeam(req.params.id)?.orchestratorSessionId;
    try {
      const team = updateTeam(req.params.id, {
        name,
        orchestratorSessionId,
        instructions: instructionsProvided
          ? body.instructions ?? null
          : undefined,
      });
      // Relaunch only if the orchestrator actually CHANGED — a no-op reassign
      // (e.g. a rename PATCH that resends the same id) shouldn't restart a
      // working orchestrator or re-mint its token mid-session.
      if (orchestratorSessionId && orchestratorSessionId !== priorOrchestrator) {
        relaunchOrchestratorTerminal(orchestratorSessionId);
      }
      return team;
    } catch (err) {
      return replyForError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req, reply) => {
    if (!deleteTeam(req.params.id)) {
      reply.code(404);
      return { error: 'team not found' };
    }
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: {
      sessionId?: string;
      alias?: string;
      instructions?: string | null;
      tags?: string[];
    };
  }>('/api/teams/:id/members', async (req, reply) => {
    const sessionId = req.body?.sessionId?.trim();
    const alias = req.body?.alias?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: 'sessionId is required' };
    }
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    try {
      return addMember({
        teamId: req.params.id,
        sessionId,
        alias,
        instructions: req.body?.instructions ?? null,
        tags: req.body?.tags,
      });
    } catch (err) {
      return replyForError(reply, err);
    }
  });

  app.patch<{
    Params: { id: string; sessionId: string };
    Body: {
      alias?: string;
      instructions?: string | null;
      tags?: string[];
    };
  }>('/api/teams/:id/members/:sessionId', async (req, reply) => {
    const aliasRaw = req.body?.alias;
    const alias =
      typeof aliasRaw === 'string' ? aliasRaw.trim() : undefined;
    if (aliasRaw !== undefined && !alias) {
      reply.code(400);
      return { error: 'alias cannot be empty' };
    }
    // PATCH semantics: an absent key means "leave alone"; an explicit
    // value (including `null` for instructions, `[]` for tags) means
    // "set to that". `'key' in body` distinguishes absent from
    // explicit-null because JSON.stringify drops `undefined` but
    // preserves `null`.
    const body = req.body ?? {};
    const instructionsProvided = 'instructions' in body;
    const tagsProvided = 'tags' in body;
    try {
      return updateMember({
        teamId: req.params.id,
        sessionId: req.params.sessionId,
        alias,
        instructions: instructionsProvided
          ? body.instructions ?? null
          : undefined,
        tags: tagsProvided ? body.tags ?? [] : undefined,
      });
    } catch (err) {
      return replyForError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; sessionId: string } }>(
    '/api/teams/:id/members/:sessionId',
    async (req, reply) => {
      const ok = removeMember(req.params.id, req.params.sessionId);
      if (!ok) {
        reply.code(404);
        return { error: 'member not found' };
      }
      return { ok: true };
    },
  );
}
