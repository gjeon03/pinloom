import 'dotenv/config';
import { DEFAULT_BACKEND_PORT } from '@pinloom/shared';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || DEFAULT_BACKEND_PORT;

const app = await createApp();

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`pinloom backend listening on http://localhost:${PORT}`);
