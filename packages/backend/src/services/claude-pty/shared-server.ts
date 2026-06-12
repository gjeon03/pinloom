// One Stop-hook server shared by every claude the backend drives — the PTY
// adapter (node-session.ts) and terminal mode (agent-terminal.ts) both route
// their turn-completion hooks here. Lazily started; closed on backend shutdown.

import { startStopHookServer, type StopHookServer } from './stop-hook-server.js';

let sharedServer: Promise<StopHookServer> | null = null;

export function getStopHookServer(): Promise<StopHookServer> {
  return (sharedServer ??= startStopHookServer());
}

export async function shutdownStopHookServer(): Promise<void> {
  if (!sharedServer) return;
  const s = await sharedServer;
  sharedServer = null;
  await s.close();
}
