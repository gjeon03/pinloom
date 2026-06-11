// HTTP surface consumed by the pinloom MCP server (`packages/mcp-server`)
// when an orchestrator agent dispatches work to its team's worker
// sessions. Routes are scoped under `/api/teams/:teamId/dispatch/*` and
// authenticated by the `X-Pinloom-Team-Token` header — the token is
// minted in-memory at orchestrator-spawn time (services/team-tokens.ts)
// and dies with the backend, so a stale shim from a previous run can't
// keep dispatching after the user has moved on.
//
// Nine tools live here, mirroring the MCP shim's surface:
//   GET  /list                                                 — team_list
//   POST /send          {alias, text}                          — team_send (fire-and-forget)
//   POST /send-tag      {tag, text}                            — team_send_tag (fanout, async)
//   POST /ask           {alias, text, timeoutMs?}              — team_ask (sync — wait for reply)
//   POST /ask-tag       {tag, text, timeoutMs?}                — team_ask_tag (sync fanout)
//   POST /update-member {alias, newAlias?, instructions?, tags?} — team_update_member
//   GET  /messages      ?alias=&sinceMessageId=                — team_read
//   GET  /status        ?alias=                                — team_status
//   GET  /wait          ?alias=&timeoutMs=                     — team_wait (long-poll)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/connection.js';
import {
  AliasTakenError,
  createWorker,
  getMemberByAlias,
  getTeam,
  InstructionsTooLongError,
  InvalidAliasError,
  InvalidTagError,
  listMembersByTag,
  ProjectNotFoundError,
  TeamNotFoundError,
  TooManyTagsError,
  TooManyWorkersError,
  updateMember,
} from '../services/teams.js';
import { getProjectWikiSlugByProjectId } from '../services/wiki-sync.js';
import { broadcast } from '../ws/hub.js';
import {
  enqueueMessage,
  InvalidQueueContentError,
  listQueueItems,
  SessionNotFoundError,
} from '../services/message-queue.js';
import { isAiRunning, tryDrainQueue, waitForIdle } from '../services/runner.js';
import { dispatchToWorker } from '../services/claude-pty/agent-terminal.js';
import { resolveTeamByToken } from '../services/team-tokens.js';
import {
  emitDispatchEvent,
  listRecentEvents,
} from '../services/team-events.js';

interface SessionRow {
  id: string;
  project_id: string;
  agent: 'claude' | 'codex' | null;
}

// Hard cap so a buggy MCP client can't pin a connection open for hours.
// 5 minutes covers the common review/investigation case without forcing
// the orchestrator into a polling loop. AbortSignal still releases the
// wait the moment the client disconnects.
const MAX_WAIT_MS = 5 * 60_000;

// Mirrors the service-layer tag pattern; we validate at the route so an
// invalid query tag returns a clear 400 instead of silently producing
// recipients=[] (which the orchestrator would read as "no matches").
const TAG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

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

  // A 'terminal' worker has no runner driving it — dispatch injects into its TUI
  // (dispatchToWorker) instead of the enqueue/waitForIdle path. Terminal mode is
  // claude-only, so a codex worker (even if transport='terminal') stays on the
  // runner path.
  const isTerminalWorker = (sessionId: string): boolean => {
    const row = db
      .prepare('SELECT transport, agent FROM sessions WHERE id = ?')
      .get(sessionId) as { transport: string | null; agent: string | null } | undefined;
    return row?.transport === 'terminal' && row.agent === 'claude';
  };

  // Backfill endpoint for the descriptive canvas: returns the in-memory
  // ring buffer of recent dispatch events for this team. Open to the
  // browser (no MCP token required) since the canvas is just observing
  // already-public team state.
  app.get<{
    Params: { teamId: string };
    Querystring: { limit?: string };
  }>('/api/teams/:teamId/dispatch/events', async (req) => {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1),
      500,
    );
    return listRecentEvents(req.params.teamId, limit);
  });

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

  // List the projects an orchestrator can place a worker in (name, slug, cwd,
  // session count). The orchestrator calls this before `create-worker` to pick
  // a cross-project target by slug/name.
  app.get<{ Params: { teamId: string } }>(
    '/api/teams/:teamId/dispatch/projects',
    async (req, reply) => {
      if (!authorize(req, reply)) return;
      const rows = db
        .prepare('SELECT id, name, cwd FROM projects ORDER BY order_index ASC, created_at DESC')
        .all() as { id: string; name: string; cwd: string }[];
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: getProjectWikiSlugByProjectId(p.id),
        cwd: p.cwd,
        sessionCount: (
          db
            .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
            .get(p.id) as { n: number }
        ).n,
      }));
    },
  );

  // Create a new worker session + add it to the team (MCP team_create_worker).
  // `project` selects the target project by id, slug, or name (default: the
  // orchestrator's project). Reuses createWorker (same validation as the UI),
  // then nudges the canvas to re-fetch members.
  app.post<{
    Params: { teamId: string };
    Body: {
      alias?: string;
      instructions?: string | null;
      tags?: string[];
      project?: string;
      agent?: 'claude' | 'codex';
    };
  }>('/api/teams/:teamId/dispatch/create-worker', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const teamId = req.params.teamId;
    const alias = req.body?.alias?.trim();
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    if (req.body?.agent && req.body.agent !== 'claude' && req.body.agent !== 'codex') {
      reply.code(400);
      return { error: `unknown agent: ${req.body.agent}` };
    }
    // Resolve the optional project selector (id | slug | name) to a project id.
    let projectId: string | undefined;
    const sel = req.body?.project?.trim();
    if (sel) {
      const projects = db
        .prepare('SELECT id, name, cwd FROM projects')
        .all() as { id: string; name: string; cwd: string }[];
      const match =
        projects.find((p) => p.id === sel) ??
        projects.find((p) => getProjectWikiSlugByProjectId(p.id) === sel) ??
        projects.find((p) => p.name === sel);
      if (!match) {
        reply.code(404);
        return {
          error: `no project matching "${sel}". Available: ${projects
            .map((p) => getProjectWikiSlugByProjectId(p.id))
            .join(', ')}`,
        };
      }
      projectId = match.id;
    }
    try {
      const worker = createWorker({
        teamId,
        alias,
        instructions: req.body?.instructions ?? null,
        tags: req.body?.tags,
        projectId,
        agent: req.body?.agent,
      });
      console.warn(
        `[team-dispatch] orchestrator created worker @${worker.alias} in project "${worker.projectName}" (${worker.transport})`,
      );
      broadcast(`team:${teamId}`, { type: 'team_members_changed', teamId });
      return { ok: true as const, worker };
    } catch (err) {
      if (err instanceof TeamNotFoundError || err instanceof ProjectNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof AliasTakenError) {
        reply.code(409);
        return { error: err.message };
      }
      if (err instanceof TooManyWorkersError) {
        reply.code(409);
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
      throw err;
    }
  });

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
    // Terminal worker: fire-and-forget inject into its TUI (the reply lands in
    // the terminal + capture; the orchestrator doesn't wait on /send).
    if (isTerminalWorker(member.sessionId)) {
      // Fire-and-forget: don't await, but surface a failed dispatch instead of
      // silently dropping the DispatchResult.
      void dispatchToWorker(member.sessionId, text, new AbortController().signal).then((r) => {
        if (!r.ok) {
          console.warn(`[team-dispatch] /send to @${member.alias} failed: ${r.error}`);
        }
      });
      emitDispatchEvent({
        type: 'dispatch_send',
        teamId: req.params.teamId,
        alias: member.alias,
        sessionId: member.sessionId,
        previewText: text.length > 120 ? `${text.slice(0, 117)}…` : text,
        at: new Date().toISOString(),
      });
      return { ok: true, queueItemId: `terminal:${member.sessionId}` };
    }
    try {
      const item = enqueueMessage({ sessionId: member.sessionId, content: text });
      // Worker session may be idle — kick off a drain so the dispatched
      // prompt actually reaches its agent instead of sitting in the queue
      // until the worker happens to receive its next user message.
      tryDrainQueue(member.sessionId);
      emitDispatchEvent({
        type: 'dispatch_send',
        teamId: req.params.teamId,
        alias: member.alias,
        sessionId: member.sessionId,
        previewText: text.length > 120 ? `${text.slice(0, 117)}…` : text,
        at: new Date().toISOString(),
      });
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

  // Broadcast variant: enqueue the same prompt to every worker tagged
  // with `tag`. Returns per-recipient enqueue results. We deliberately
  // do NOT short-circuit on the first failure — partial fanout is
  // strictly more useful than nothing, and the orchestrator can re-try
  // selectively against the failed aliases. Each successful enqueue
  // emits its own dispatch_send event so the canvas animates the same
  // way as a series of single sends.
  app.post<{
    Params: { teamId: string };
    Body: { tag?: string; text?: string };
  }>('/api/teams/:teamId/dispatch/send-tag', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const tag = req.body?.tag?.trim();
    const text = req.body?.text;
    if (!tag) {
      reply.code(400);
      return { error: 'tag is required' };
    }
    // Tags are stored under the same pattern alias uses; surface a 400
    // when the query value couldn't possibly match a stored tag rather
    // than silently returning recipients=[] (which the orchestrator
    // would interpret as "no workers tagged X").
    if (!TAG_PATTERN.test(tag)) {
      reply.code(400);
      return {
        error: `invalid tag ${JSON.stringify(tag)}: must match /^[a-z][a-z0-9_-]{0,31}$/`,
      };
    }
    if (typeof text !== 'string' || text.length === 0) {
      reply.code(400);
      return { error: 'text is required' };
    }
    const recipients = listMembersByTag(req.params.teamId, tag);
    if (recipients.length === 0) {
      // Not a 404 — the team exists, the request is well-formed, just
      // nothing matches. ok=false so the orchestrator's success path
      // can branch on it cleanly.
      return { ok: false, recipients: [], failures: [] };
    }
    const previewText =
      text.length > 120 ? `${text.slice(0, 117)}…` : text;
    // Shared timestamp across the whole fanout so the canvas treats the
    // burst as one logical event group; per-alias key still keeps
    // events distinguishable.
    const dispatchedAt = new Date().toISOString();
    const results: Array<{
      alias: string;
      sessionId: string;
      queueItemId: string;
    }> = [];
    const failures: Array<{ alias: string; error: string }> = [];
    for (const member of recipients) {
      let queueItemId: string;
      try {
        const item = enqueueMessage({
          sessionId: member.sessionId,
          content: text,
        });
        queueItemId = item.id;
      } catch (err) {
        failures.push({
          alias: member.alias,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // The enqueue is committed at this point — the recipient is
      // already going to receive the message. A subsequent drain or
      // canvas-event failure must NOT be reported as a per-recipient
      // failure or the orchestrator may double-send on retry.
      results.push({
        alias: member.alias,
        sessionId: member.sessionId,
        queueItemId,
      });
      try {
        tryDrainQueue(member.sessionId);
        emitDispatchEvent({
          type: 'dispatch_send',
          teamId: req.params.teamId,
          alias: member.alias,
          sessionId: member.sessionId,
          previewText,
          at: dispatchedAt,
        });
      } catch (err) {
        // Drain / event-emit are best-effort: the queue item already
        // landed, so the worker will pick it up at the next turn
        // boundary regardless. Log so a future regression isn't
        // invisible.
        // eslint-disable-next-line no-console
        console.warn(
          `[team-dispatch] post-enqueue side effect failed for @${member.alias}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // ok mirrors "did anything actually get queued?" — orchestrators
    // that branch on truthiness need a non-misleading signal.
    return { ok: results.length > 0, recipients: results, failures };
  });

  // Lets the orchestrator update a worker's instructions / tags / alias
  // mid-session. Reuses the same validation + persistence path the
  // human-facing PATCH endpoint uses, so no orchestrator-specific
  // bypasses exist. Add/remove worker stays out of this surface — those
  // create sessions / break invariants and want a more deliberate UI.
  //
  // Partial-update semantics mirror the human PATCH route:
  //   - omit a field         → leave unchanged
  //   - set instructions=null → clear
  //   - set tags=[]          → clear
  //   - set alias="newName"  → rename (must still match alias regex,
  //                            and must not collide with another worker
  //                            in this team)
  app.post<{
    Params: { teamId: string };
    Body: {
      alias?: string;
      newAlias?: string;
      instructions?: string | null;
      tags?: string[];
    };
  }>('/api/teams/:teamId/dispatch/update-member', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const alias = req.body?.alias?.trim();
    if (!alias) {
      reply.code(400);
      return { error: 'alias is required' };
    }
    const member = getMemberByAlias(req.params.teamId, alias);
    if (!member) {
      reply.code(404);
      return { error: `no worker with alias "${alias}" in this team` };
    }
    // Distinguish "field absent" (leave alone) from "field present
    // with null" (clear) the same way the human PATCH does.
    const body = req.body ?? {};
    const instructionsProvided = 'instructions' in body;
    const tagsProvided = 'tags' in body;
    const newAliasRaw = body.newAlias;
    const newAlias =
      typeof newAliasRaw === 'string' ? newAliasRaw.trim() : undefined;
    if (newAliasRaw !== undefined && !newAlias) {
      reply.code(400);
      return { error: 'newAlias cannot be empty' };
    }
    // Reject `instructions: ""` outright instead of silently treating
    // it the same as `instructions: null`. The MCP description tells
    // the orchestrator "pass null to clear" — an LLM sending `""`
    // thinking it's a harmless no-op should hit a clear error rather
    // than wipe the worker's role. Empty/whitespace string ≠ null.
    if (
      instructionsProvided &&
      typeof body.instructions === 'string' &&
      body.instructions.trim() === ''
    ) {
      reply.code(400);
      return {
        error:
          'instructions cannot be an empty/whitespace string — pass null to clear',
      };
    }
    try {
      const updated = updateMember({
        teamId: req.params.teamId,
        sessionId: member.sessionId,
        alias: newAlias,
        instructions: instructionsProvided
          ? body.instructions ?? null
          : undefined,
        tags: tagsProvided ? body.tags ?? [] : undefined,
      });
      // Audit trail — single-user local app, but a console line lets
      // the user see when the orchestrator mutated team state without
      // tailing the SQLite DB.
      // eslint-disable-next-line no-console
      console.warn(
        `[team-dispatch] orchestrator updated @${alias}` +
          (newAlias && newAlias !== alias ? ` → @${newAlias}` : '') +
          (instructionsProvided
            ? body.instructions
              ? ' (instructions set)'
              : ' (instructions cleared)'
            : '') +
          (tagsProvided
            ? body.tags && body.tags.length > 0
              ? ` (tags=${JSON.stringify(body.tags)})`
              : ' (tags cleared)'
            : ''),
      );
      return { ok: true, member: updated };
    } catch (err) {
      if (err instanceof TeamNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof AliasTakenError) {
        reply.code(409);
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
      throw err;
    }
  });

  // Synchronous variant of /send: enqueues, blocks until the worker
  // turn finishes, returns the worker's final assistant reply directly.
  // Mirrors the Claude Agent SDK's Task tool — orchestrator calls one
  // tool and gets the answer back as the tool_result, never having to
  // separately team_wait + team_read. The orchestrator's turn can stay
  // alive across the whole round trip.
  //
  // Caveat (acceptable for v1): if the worker already has unrelated
  // queued items, "the latest assistant message after we waited" may
  // not strictly be the answer to the message we just enqueued. In
  // practice an orch dispatching to one worker at a time doesn't
  // produce that pile-up. A future improvement could tag the queue
  // item with a request id and link the resulting messages.
  app.post<{
    Params: { teamId: string };
    Body: { alias?: string; text?: string; timeoutMs?: number };
  }>('/api/teams/:teamId/dispatch/ask', async (req, reply) => {
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
    const requested = req.body?.timeoutMs;
    const timeoutMs =
      typeof requested === 'number' && Number.isFinite(requested)
        ? Math.min(Math.max(Math.floor(requested), 100), MAX_WAIT_MS)
        : MAX_WAIT_MS;

    // Terminal-mode worker: no runner drives it, so enqueue/waitForIdle don't
    // apply. Inject the prompt into the worker's TUI and read the reply straight
    // from the Stop-hook payload (capture persists the rows asynchronously).
    if (isTerminalWorker(member.sessionId)) {
      emitDispatchEvent({
        type: 'dispatch_send',
        teamId: req.params.teamId,
        alias: member.alias,
        sessionId: member.sessionId,
        previewText: text.length > 120 ? `${text.slice(0, 117)}…` : text,
        at: new Date().toISOString(),
      });
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.raw.once('close', onClose);
      let result;
      try {
        result = await dispatchToWorker(member.sessionId, text, ac.signal, timeoutMs);
      } finally {
        req.raw.off('close', onClose);
      }
      if (!result.ok) {
        return {
          ok: false,
          idle: false,
          alias: member.alias,
          sessionId: member.sessionId,
          error: result.error,
        };
      }
      return {
        ok: true,
        idle: true,
        alias: member.alias,
        sessionId: member.sessionId,
        message: {
          id: `terminal:${member.sessionId}`,
          content: result.reply,
          createdAt: new Date().toISOString(),
        },
      };
    }

    // Snapshot before enqueue so we can disambiguate "new" assistant
    // messages from anything that already existed.
    const before = new Date().toISOString();
    let queueItemId: string;
    try {
      const item = enqueueMessage({
        sessionId: member.sessionId,
        content: text,
      });
      queueItemId = item.id;
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
    tryDrainQueue(member.sessionId);
    emitDispatchEvent({
      type: 'dispatch_send',
      teamId: req.params.teamId,
      alias: member.alias,
      sessionId: member.sessionId,
      previewText: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      at: before,
    });
    const ac = new AbortController();
    // Match the /wait route's listener-cleanup pattern (once + off in
    // finally) so a long-lived backend doesn't leak a closure on
    // IncomingMessage per /ask call.
    const onSocketClose = () => ac.abort();
    req.raw.once('close', onSocketClose);
    let idle = false;
    try {
      idle = await waitForIdle(member.sessionId, timeoutMs, ac.signal);
    } finally {
      req.raw.off('close', onSocketClose);
    }
    if (!idle) {
      // Worker hasn't completed yet — let the orch decide whether to
      // poll again or give up. Don't 5xx; this is a normal "didn't
      // make it in the budget" outcome.
      return {
        ok: false,
        idle: false,
        alias: member.alias,
        sessionId: member.sessionId,
        queueItemId,
      };
    }
    // Pick up the latest assistant message produced after our enqueue.
    const reply_ = db
      .prepare(
        `SELECT id, content, created_at FROM messages
         WHERE session_id = ? AND role = 'assistant' AND created_at > ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(member.sessionId, before) as
      | { id: string; content: string; created_at: string }
      | undefined;
    return {
      ok: true,
      idle: true,
      alias: member.alias,
      sessionId: member.sessionId,
      queueItemId,
      message: reply_
        ? {
            id: reply_.id,
            content: reply_.content,
            createdAt: reply_.created_at,
          }
        : null,
    };
  });

  // Broadcast variant of /ask: fan out to every worker tagged with
  // `tag`, wait for ALL in parallel, return each one's final reply.
  // Per-recipient timeout is independent — a slow worker doesn't block
  // a fast one's reply from being collected.
  app.post<{
    Params: { teamId: string };
    Body: { tag?: string; text?: string; timeoutMs?: number };
  }>('/api/teams/:teamId/dispatch/ask-tag', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const tag = req.body?.tag?.trim();
    const text = req.body?.text;
    if (!tag) {
      reply.code(400);
      return { error: 'tag is required' };
    }
    if (!TAG_PATTERN.test(tag)) {
      reply.code(400);
      return {
        error: `invalid tag ${JSON.stringify(tag)}: must match /^[a-z][a-z0-9_-]{0,31}$/`,
      };
    }
    if (typeof text !== 'string' || text.length === 0) {
      reply.code(400);
      return { error: 'text is required' };
    }
    const recipients = listMembersByTag(req.params.teamId, tag);
    if (recipients.length === 0) {
      return { ok: false, replies: [], failures: [], timedOut: [] };
    }
    const requested = req.body?.timeoutMs;
    const timeoutMs =
      typeof requested === 'number' && Number.isFinite(requested)
        ? Math.min(Math.max(Math.floor(requested), 100), MAX_WAIT_MS)
        : MAX_WAIT_MS;
    const previewText =
      text.length > 120 ? `${text.slice(0, 117)}…` : text;
    const dispatchedAt = new Date().toISOString();
    const ac = new AbortController();
    // Single AbortController is intentional — the only abort source is
    // the request socket closing, which is an all-or-nothing event.
    // Once + off cleanup so a long-lived backend doesn't leak per
    // /ask-tag call.
    const onSocketClose = () => ac.abort();
    req.raw.once('close', onSocketClose);

    type ReplyEntry = {
      alias: string;
      sessionId: string;
      queueItemId: string;
      message: { id: string; content: string; createdAt: string } | null;
    };
    type FailureEntry = { alias: string; error: string };
    type TimeoutEntry = {
      alias: string;
      sessionId: string;
      queueItemId: string;
    };

    const replies: ReplyEntry[] = [];
    const failures: FailureEntry[] = [];
    const timedOut: TimeoutEntry[] = [];

    try {
      await Promise.all(
        recipients.map(async (member) => {
          // Terminal worker: inject into its TUI, reply from the Stop payload.
          if (isTerminalWorker(member.sessionId)) {
            emitDispatchEvent({
              type: 'dispatch_send',
              teamId: req.params.teamId,
              alias: member.alias,
              sessionId: member.sessionId,
              previewText,
              at: dispatchedAt,
            });
            const result = await dispatchToWorker(member.sessionId, text, ac.signal, timeoutMs);
            if (result.ok) {
              replies.push({
                alias: member.alias,
                sessionId: member.sessionId,
                queueItemId: `terminal:${member.sessionId}`,
                message: {
                  id: `terminal:${member.sessionId}`,
                  content: result.reply,
                  createdAt: new Date().toISOString(),
                },
              });
            } else {
              failures.push({ alias: member.alias, error: result.error });
            }
            return;
          }
          let queueItemId: string;
          try {
            const item = enqueueMessage({
              sessionId: member.sessionId,
              content: text,
            });
            queueItemId = item.id;
          } catch (err) {
            failures.push({
              alias: member.alias,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          try {
            tryDrainQueue(member.sessionId);
            emitDispatchEvent({
              type: 'dispatch_send',
              teamId: req.params.teamId,
              alias: member.alias,
              sessionId: member.sessionId,
              previewText,
              at: dispatchedAt,
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[team-dispatch] post-enqueue side effect failed for @${member.alias}:`,
              err instanceof Error ? err.message : err,
            );
          }
          const idle = await waitForIdle(
            member.sessionId,
            timeoutMs,
            ac.signal,
          );
          if (!idle) {
            timedOut.push({
              alias: member.alias,
              sessionId: member.sessionId,
              queueItemId,
            });
            return;
          }
          const reply_ = db
            .prepare(
              `SELECT id, content, created_at FROM messages
               WHERE session_id = ? AND role = 'assistant' AND created_at > ?
               ORDER BY created_at DESC, id DESC
               LIMIT 1`,
            )
            .get(member.sessionId, dispatchedAt) as
            | { id: string; content: string; created_at: string }
            | undefined;
          replies.push({
            alias: member.alias,
            sessionId: member.sessionId,
            queueItemId,
            message: reply_
              ? {
                  id: reply_.id,
                  content: reply_.content,
                  createdAt: reply_.created_at,
                }
              : null,
          });
        }),
      );
    } finally {
      req.raw.off('close', onSocketClose);
    }

    return {
      // ok mirrors "did at least one worker actually produce a reply?".
      // A worker that idled with only tool calls (no assistant text)
      // ends up in `replies` with `message: null` — that's not useful
      // signal, so it shouldn't flip ok to true on its own.
      ok: replies.some((r) => r.message !== null),
      replies,
      failures,
      timedOut,
    };
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
    type MessageRow = {
      id: string;
      role: string;
      content: string;
      created_at: string;
    };
    let rows: MessageRow[];
    if (req.query.sinceMessageId) {
      // Chronological forward pagination: "give me everything strictly
      // after this message". We compare the (created_at, id) tuple so
      // same-millisecond siblings of the cursor are paginated correctly
      // — comparing only created_at would silently drop them.
      const sinceRow = db
        .prepare(
          'SELECT id, created_at FROM messages WHERE id = ? AND session_id = ?',
        )
        .get(req.query.sinceMessageId, member.sessionId) as
        | { id: string; created_at: string }
        | undefined;
      if (!sinceRow) {
        reply.code(404);
        return {
          error: `sinceMessageId not found in worker @${alias}'s history`,
        };
      }
      rows = db
        .prepare(
          `SELECT id, role, content, created_at FROM messages
           WHERE session_id = ? AND role IN ('user','assistant')
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(
          member.sessionId,
          sinceRow.created_at,
          sinceRow.created_at,
          sinceRow.id,
          limit,
        ) as MessageRow[];
    } else {
      // Default: "latest N messages". The 99% case for an orchestrator
      // is "what did the worker just say" — chronological-forward with
      // no anchor was returning persona-setup turns instead. Fetch
      // newest-first then reverse so the response stays chronological.
      const newest = db
        .prepare(
          `SELECT id, role, content, created_at FROM messages
           WHERE session_id = ? AND role IN ('user','assistant')
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(member.sessionId, limit) as MessageRow[];
      rows = newest.reverse();
    }
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
    // Default to the upper cap so a caller that doesn't care about the
    // exact ceiling gets the longest sensible wait without explicit
    // tuning. AbortSignal still ends it the moment the client disconnects.
    // `timeoutMs=0` is treated as "non-blocking poll" — return whatever
    // the current state is immediately rather than silently re-defaulting.
    const rawParam = req.query.timeoutMs;
    let timeoutMs: number;
    if (rawParam === '0') {
      timeoutMs = 0;
    } else {
      const requested = parseInt(rawParam ?? String(MAX_WAIT_MS), 10) || MAX_WAIT_MS;
      timeoutMs = Math.min(Math.max(requested, 100), MAX_WAIT_MS);
    }

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
