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
import { subscribe, unsubscribe } from './ws/hub.js';
import { attachTerminal, killAllTerminals } from './services/terminal.js';
import { checkAgentClis } from './services/cli-check.js';
import { loadUserEnvIntoProcess } from './services/user-env.js';
import { drainStrandedQueuesOnBoot } from './services/runner.js';

export async function createApp() {
  // 100MB body limit — image-attached messages and wiki imports both ship
  // large base64 blobs through the JSON body. Default 1MB is too tight.
  const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024 });

  getDb();

  // On shutdown, deterministically tear down terminal shells + anything they
  // spawned. app.close() awaits this, and server.ts's shutdown awaits
  // app.close() (within its 3s force-exit budget).
  app.addHook('onClose', async () => {
    await killAllTerminals();
  });

  // Mirror user-managed env vars into process.env so the very first agent
  // spawn inherits them; subsequent upserts/deletes keep this in sync.
  loadUserEnvIntoProcess();

  // Pick up any pending queue rows that survived the previous process —
  // each session's drain triggers are bound to a live AgentRun, so a
  // restart with stranded items would otherwise leave them stuck.
  drainStrandedQueuesOnBoot();

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get('/api/health', async () => {
    const agents = await checkAgentClis();
    return {
      status: 'ok' as const,
      agents,
    };
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
  await app.register(teamRoutes);
  await app.register(teamDispatchRoutes);

  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket, request) => {
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
      const handle = attachTerminal(
        projectId,
        localId,
        80,
        24,
        (data) => send({ t: 'o', d: data }),
        (code) => send({ t: 'x', code }),
      );
      if (!handle) {
        socket.close(4001, 'project not found');
        return;
      }
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
  });

  return app;
}
