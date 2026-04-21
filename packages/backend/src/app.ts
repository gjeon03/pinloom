import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { getDb } from './db/connection.js';
import { projectRoutes } from './routes/projects.js';
import { planRoutes } from './routes/plans.js';
import { sessionRoutes } from './routes/sessions.js';
import { messageRoutes } from './routes/messages.js';
import { fsRoutes } from './routes/fs.js';
import { terminalRoutes } from './routes/terminals.js';
import { subscribe, unsubscribe } from './ws/hub.js';
import { checkCli } from './services/cli-check.js';
import { attachOrSpawnPty, resizePty } from './services/terminal.js';

export async function createApp() {
  const app = Fastify({ logger: true });

  getDb();

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get('/api/health', async () => {
    const cli = await checkCli();
    return { status: 'ok' as const, cli };
  });

  await app.register(projectRoutes);
  await app.register(planRoutes);
  await app.register(sessionRoutes);
  await app.register(messageRoutes);
  await app.register(fsRoutes);
  await app.register(terminalRoutes);

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

    fastify.get('/ws/terminal', { websocket: true }, (socket, request) => {
      const terminalId = (request.query as { terminalId?: string }).terminalId;
      if (!terminalId) {
        socket.close(4000, 'terminalId query parameter required');
        return;
      }

      const pty = attachOrSpawnPty(terminalId);
      if (!pty) {
        socket.close(4004, 'terminal not found');
        return;
      }

      const ptyDataSub = pty.onData((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'data', data }));
        }
      });

      const ptyExitSub = pty.onExit(({ exitCode }) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'exit', exitCode }));
          socket.close();
        }
      });

      socket.on('message', (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        const m = msg as { type?: string; data?: string; cols?: number; rows?: number };
        if (m.type === 'input' && typeof m.data === 'string') {
          try {
            pty.write(m.data);
          } catch {
            // ignore
          }
        } else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
          resizePty(terminalId, m.cols, m.rows);
        }
      });

      socket.on('close', () => {
        ptyDataSub.dispose();
        ptyExitSub.dispose();
        // NOTE: keep PTY alive so user can reconnect. It's killed on terminal delete.
      });
    });
  });

  return app;
}
