import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { getDb } from './db/connection.js';
import { projectRoutes } from './routes/projects.js';
import { planRoutes } from './routes/plans.js';
import { sessionRoutes } from './routes/sessions.js';
import { messageRoutes } from './routes/messages.js';
import { fsRoutes } from './routes/fs.js';
import { subscribe, unsubscribe } from './ws/hub.js';
import { checkCli } from './services/cli-check.js';

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
  });

  return app;
}
