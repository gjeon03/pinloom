import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { getDb } from './db/connection.js';
import { projectRoutes } from './routes/projects.js';
import { projectGroupRoutes } from './routes/project-groups.js';
import { planRoutes } from './routes/plans.js';
import { sessionRoutes } from './routes/sessions.js';
import { messageRoutes } from './routes/messages.js';
import { fsRoutes } from './routes/fs.js';
import { wikiRoutes } from './routes/wiki.js';
import { settingsRoutes } from './routes/settings.js';
import { backupRoutes } from './routes/backup.js';
import { notepadRoutes } from './routes/notepad.js';
import { projectNotepadRoutes } from './routes/project-notepads.js';
import { teamRoutes } from './routes/teams.js';
import { teamDispatchRoutes } from './routes/team-dispatch.js';
import { searchRoutes } from './routes/search.js';
import { promptTemplateRoutes } from './routes/prompt-templates.js';
import { wikiProposalRoutes } from './routes/wiki-proposals.js';
import { userProfileRoutes } from './routes/user-profile.js';
import { botRoutes } from './routes/bots.js';
import { skillRoutes } from './routes/skills.js';
import { timelineRoutes } from './routes/timeline.js';
import { recapRoutes } from './routes/recap.js';
import { subscribe, unsubscribe } from './ws/hub.js';
import {
  attachTerminal,
  killAllTerminals,
  MAX_TERMINALS,
} from './services/terminal.js';
import { checkAgentClis } from './services/cli-check.js';
import { claudeTransport } from './services/agents/index.js';
import { shutdownClaudePty } from './services/claude-pty/index.js';
import {
  attachAgentTerminal,
  killAllAgentTerminals,
  startAgentTerminalReaper,
  stopAgentTerminalReaper,
} from './services/claude-pty/agent-terminal.js';
import {
  attachCodexTerminal,
  killAllCodexTerminals,
} from './services/codex-pty/agent-terminal.js';
import { loadUserEnvIntoProcess } from './services/user-env.js';
import { drainStrandedQueuesOnBoot } from './services/runner.js';
import { sweepStrandedDispatchesOnBoot } from './services/dispatches.js';
import { startEventLoopMonitor } from './services/event-loop-monitor.js';
import { initEmbeddings } from './services/embeddings/index.js';
import { startMessageIndexer, stopMessageIndexer } from './services/message-indexer.js';
import { startTimelineCapture, stopTimelineCapture } from './services/timeline/capture.js';
import { startWikiAuto, stopWikiAuto } from './services/wiki-auto.js';
import {
  startWikiSessionSyncAuto,
  stopWikiSessionSyncAuto,
} from './services/wiki-session-sync-auto.js';
import { registerStaticFrontend, shouldServeStatic } from './static-frontend.js';

// Guard the WebSocket routes against cross-site hijacking. The terminal
// socket is effectively local RCE, so a malicious page the user happens to
// visit must not be able to open it. Only browsers send an Origin header and
// it can't be forged from JS, so allow same-machine origins (and non-browser
// clients that send none) and reject everything else. NOTE: the frontend's
// Vite proxy must NOT use `rewriteWsOrigin`, or the real origin is masked.
function isAllowedWsOrigin(origin: string | string[] | undefined): boolean {
  if (!origin) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) return true;
  try {
    const host = new URL(value).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export async function createApp() {
  // 100MB body limit — image-attached messages and wiki imports both ship
  // large base64 blobs through the JSON body. Default 1MB is too tight.
  const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024 });

  getDb();

  // Warn when something blocks the event loop for >200ms — better-sqlite3
  // is synchronous, so a runaway query silently serializes every fetch +
  // WS handshake behind it. Skipped under tests to keep them quiet.
  if (process.env.NODE_ENV !== 'test') {
    startEventLoopMonitor();
  }

  // On shutdown, deterministically tear down terminal shells + anything they
  // spawned. app.close() awaits this, and server.ts's shutdown awaits
  // app.close() (within its 3s force-exit budget).
  app.addHook('onClose', async () => {
    stopMessageIndexer();
    stopTimelineCapture();
    stopWikiAuto();
    stopWikiSessionSyncAuto();
    stopAgentTerminalReaper();
    await killAllTerminals();
    await killAllAgentTerminals();
    await killAllCodexTerminals();
    await shutdownClaudePty();
  });

  // Mirror user-managed env vars into process.env so the very first agent
  // spawn inherits them; subsequent upserts/deletes keep this in sync.
  loadUserEnvIntoProcess();

  // Pick up any pending queue rows that survived the previous process —
  // each session's drain triggers are bound to a live AgentRun, so a
  // restart with stranded items would otherwise leave them stuck.
  drainStrandedQueuesOnBoot();

  // Fail over any dispatch that was mid-flight when the previous process
  // died — its completion signal (runner turn / terminal Stop) can never
  // arrive now, so a team_wait on it would otherwise hang forever.
  const stranded = sweepStrandedDispatchesOnBoot();
  if (stranded > 0) {
    app.log.info(`[dispatches] swept ${stranded} stranded dispatch(es) on boot`);
  }

  // Semantic search (Phase 1): warm the embedding model in the background and
  // start the message indexer's periodic sweep. Both are degrade-safe no-ops if
  // the model/extension can't load — search falls back to lexical FTS. Skipped
  // under unit tests (no model download); the isolated E2E can opt out via
  // PINLOOM_EMBEDDINGS=off.
  if (process.env.NODE_ENV !== 'test') {
    initEmbeddings();
    startMessageIndexer();
    // Work Timeline (Phase 2): background sweep distills idle sessions' day
    // activity into per-project journal entries. Out of the runner hot path,
    // degrade-safe (a distill failure is caught per-sweep).
    startTimelineCapture();
    // Auto wiki (knowledge flywheel): periodically re-analyze active projects'
    // conventions and stage them as proposals for review. Conservative gates +
    // human accept keep it from polluting the always-injected wiki.
    startWikiAuto();
    // The conversation half of the flywheel: distill idle sessions' new
    // messages into wiki proposals (domain/product knowledge that never lives
    // in code). Same gates + human accept.
    startWikiSessionSyncAuto();
    // Reap detached + idle agent-terminal claude TUIs (~80MB each) after a
    // generous idle window. Safe: reopening relaunches with `--resume`, so the
    // session restores; this just bounds lingering processes.
    startAgentTerminalReaper();
  }

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get('/api/health', async () => {
    const agents = await checkAgentClis();
    return {
      status: 'ok' as const,
      agents,
    };
  });

  // Cheap liveness check for the frontend's backend-up poller. Unlike
  // /api/health it does NO work (health spawns `claude`/`codex --version`).
  // `logLevel: 'silent'` suppresses the per-request log lines so an open tab
  // heartbeating in the background doesn't fill the console.
  app.get('/api/ping', { logLevel: 'silent' }, async () => {
    return { ok: true as const };
  });

  // Server-side config the frontend needs at boot. `claudeTransport` decides
  // which pane a claude session renders (chat vs terminal) — it's a backend env,
  // so the frontend fetches it once. See docs/terminal-chat-mode-plan.md.
  app.get('/api/config', async () => {
    return { claudeTransport: claudeTransport() };
  });

  await app.register(projectRoutes);
  await app.register(projectGroupRoutes);
  await app.register(planRoutes);
  await app.register(sessionRoutes);
  await app.register(messageRoutes);
  await app.register(fsRoutes);
  await app.register(wikiRoutes);
  await app.register(settingsRoutes);
  await app.register(backupRoutes);
  await app.register(notepadRoutes);
  await app.register(projectNotepadRoutes);
  await app.register(promptTemplateRoutes);
  await app.register(wikiProposalRoutes);
  await app.register(userProfileRoutes);
  await app.register(botRoutes);
  await app.register(skillRoutes);
  await app.register(timelineRoutes);
  await app.register(recapRoutes);
  await app.register(teamRoutes);
  await app.register(teamDispatchRoutes);
  await app.register(searchRoutes);

  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket, request) => {
      // A ws with no 'error' listener crashes the WHOLE process when its socket
      // errors (EPIPE/ECONNRESET when a subscriber vanishes mid-broadcast). Log
      // and swallow; the 'close' below still runs teardown.
      socket.on('error', (err) => fastify.log.warn({ err: String(err) }, 'ws socket error (ignored)'));
      if (!isAllowedWsOrigin(request.headers.origin)) {
        socket.close(4403, 'forbidden origin');
        return;
      }
      const channel = (request.query as { channel?: string }).channel;
      if (!channel) {
        socket.close(4000, 'channel query parameter required');
        return;
      }
      subscribe(channel, socket);
      socket.on('close', () => unsubscribe(channel, socket));
    });

    // Bidirectional terminal socket — unlike /ws (broadcast-only) this reads
    // client keystrokes and pipes them into a node-pty shell. Protocol:
    //   client→server: {t:'i',d} input · {t:'r',c,r} resize
    //   server→client: {t:'o',d} output · {t:'x',code} shell exited
    fastify.get('/ws/terminal', { websocket: true }, (socket, request) => {
      socket.on('error', (err) => fastify.log.warn({ err: String(err) }, 'ws socket error (ignored)'));
      if (!isAllowedWsOrigin(request.headers.origin)) {
        socket.close(4403, 'forbidden origin');
        return;
      }
      const q = request.query as { project?: string; t?: string };
      const projectId = q.project;
      const localId = q.t;
      if (!projectId || !localId) {
        socket.close(4000, 'project and t query parameters required');
        return;
      }
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const result = attachTerminal(
        projectId,
        localId,
        80,
        24,
        (data) => send({ t: 'o', d: data }),
        (code) => send({ t: 'x', code }),
      );
      if (!result.ok) {
        if (result.reason === 'capped') {
          socket.close(
            4002,
            `terminal limit reached (max ${MAX_TERMINALS}) — close another terminal and retry`,
          );
        } else {
          socket.close(4001, 'project not found');
        }
        return;
      }
      const handle = result.handle;
      // Mark the scrollback replay so the client can suppress echoing
      // xterm's responses to any terminal queries embedded in it (e.g. a
      // prior TUI's Device Attributes request) back into the shell — that
      // leak is what produced stray "1;2c" at the prompt on reconnect.
      if (handle.buffer) send({ t: 'o', d: handle.buffer, replay: true });
      socket.on('message', (raw: Buffer) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') {
          handle.write(msg.d);
        } else if (
          msg.t === 'r' &&
          typeof msg.c === 'number' &&
          typeof msg.r === 'number'
        ) {
          handle.resize(msg.c, msg.r);
        }
      });
      socket.on('close', () => handle.detach());
    });

    // Per-session agent terminal — runs the real `claude` TUI for one session
    // (terminal-chat mode). Same wire protocol as /ws/terminal; keyed by session.
    fastify.get('/ws/agent-terminal', { websocket: true }, async (socket, request) => {
      socket.on('error', (err) => fastify.log.warn({ err: String(err) }, 'ws socket error (ignored)'));
      if (!isAllowedWsOrigin(request.headers.origin)) {
        socket.close(4403, 'forbidden origin');
        return;
      }
      const q = request.query as { session?: string };
      const sessionId = q.session;
      if (!sessionId) {
        socket.close(4000, 'session query parameter required');
        return;
      }
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      // Route to the codex or claude terminal lifecycle by the session's agent.
      const agentRow = getDb()
        .prepare('SELECT agent FROM sessions WHERE id = ?')
        .get(sessionId) as { agent: string | null } | undefined;
      const agentName = agentRow?.agent === 'codex' ? 'codex' : 'claude';
      const attach = agentRow?.agent === 'codex' ? attachCodexTerminal : attachAgentTerminal;
      let result: Awaited<ReturnType<typeof attach>>;
      try {
        result = await attach(
          sessionId,
          120,
          40,
          (data) => send({ t: 'o', d: data }),
          (code) => send({ t: 'x', code }),
        );
      } catch (err) {
        // The CLI binary isn't on PATH (or pty.spawn otherwise failed). Without
        // this the rejection escapes the handler, the socket just drops with no
        // reason, and the client reconnect-loops forever. Surface it instead.
        const m = err instanceof Error ? err.message : String(err);
        const notFound = /ENOENT|not found|no such file/i.test(m);
        socket.close(
          4003,
          notFound
            ? `${agentName} CLI not found on PATH — install it or fix PATH`
            : `failed to start ${agentName} terminal: ${m}`.slice(0, 120),
        );
        return;
      }
      if (!result.ok) {
        if (result.reason === 'capped') {
          socket.close(4002, `agent terminal limit reached — close another and retry`);
        } else {
          socket.close(4001, 'session not found or project directory missing');
        }
        return;
      }
      const handle = result.handle;
      if (handle.buffer) send({ t: 'o', d: handle.buffer, replay: true });
      socket.on('message', (raw: Buffer) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') {
          handle.write(msg.d);
        } else if (msg.t === 'r' && typeof msg.c === 'number' && typeof msg.r === 'number') {
          handle.resize(msg.c, msg.r);
        }
      });
      socket.on('close', () => handle.detach());
    });
  });

  // Opt-in: serve the built frontend from this same server so the desktop
  // app's bundled sidecar runs a single origin (no separate Vite server).
  // Registered last so /api + /ws routes match first and own their 404s.
  if (shouldServeStatic()) {
    await registerStaticFrontend(app);
  }

  return app;
}
