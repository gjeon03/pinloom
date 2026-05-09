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
import { teamRoutes } from './routes/teams.js';
import { teamDispatchRoutes } from './routes/team-dispatch.js';
import { subscribe, unsubscribe } from './ws/hub.js';
import { checkAgentClis } from './services/cli-check.js';
import { loadUserEnvIntoProcess } from './services/user-env.js';
import { drainStrandedQueuesOnBoot } from './services/runner.js';

export async function createApp() {
  // 100MB body limit — image-attached messages and wiki imports both ship
  // large base64 blobs through the JSON body. Default 1MB is too tight.
  const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024 });

  getDb();

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
  });

  return app;
}
