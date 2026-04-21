import 'dotenv/config';
import { DEFAULT_BACKEND_PORT } from '@pinloom/shared';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || DEFAULT_BACKEND_PORT;

const app = await createApp();

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`pinloom backend listening on http://localhost:${PORT}`);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, closing server…`);

  const timer = setTimeout(() => {
    app.log.warn('forced exit after 3s shutdown timeout');
    process.exit(1);
  }, 3000);
  timer.unref();

  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
