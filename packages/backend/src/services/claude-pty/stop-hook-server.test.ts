import { describe, it, expect, afterEach } from 'vitest';
import { startStopHookServer, type StopHookServer } from './stop-hook-server.js';

let server: StopHookServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function post(url: string, payload: unknown): Promise<void> {
  await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
}

describe('startStopHookServer', () => {
  it('resolves awaitStop when a matching Stop payload arrives', async () => {
    server = await startStopHookServer();
    const ac = new AbortController();
    const waited = server.awaitStop('sess-A', ac.signal);
    await post(server.url(), { session_id: 'sess-A', hook_event_name: 'Stop' });
    await expect(waited).resolves.toBeUndefined();
  });

  it('resolves immediately if the hook fired before arming (race)', async () => {
    server = await startStopHookServer();
    await post(server.url(), { session_id: 'sess-B' });
    // arm AFTER the hook already fired
    await expect(server.awaitStop('sess-B', new AbortController().signal)).resolves.toBeUndefined();
  });

  it('does not resolve for a different session', async () => {
    server = await startStopHookServer();
    const ac = new AbortController();
    const waited = server.awaitStop('sess-C', ac.signal);
    await post(server.url(), { session_id: 'someone-else' });
    let settled = false;
    void waited.then(() => (settled = true)).catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    ac.abort(); // cleanup the pending waiter
    await waited.catch(() => {});
  });

  it('rejects on abort', async () => {
    server = await startStopHookServer();
    const ac = new AbortController();
    const waited = server.awaitStop('sess-D', ac.signal);
    ac.abort();
    await expect(waited).rejects.toThrow(/aborted/);
  });

  it('release() rejects a pending waiter and drops bookkeeping', async () => {
    server = await startStopHookServer();
    const waited = server.awaitStop('sess-R', new AbortController().signal);
    server.release('sess-R');
    await expect(waited).rejects.toThrow(/released/);
  });

  it('ignores POSTs to the wrong token path', async () => {
    server = await startStopHookServer();
    const ac = new AbortController();
    const waited = server.awaitStop('sess-T', ac.signal);
    // forge a POST to a guessed path without the token
    await fetch('http://127.0.0.1:' + new URL(server.url()).port + '/stop/wrong', {
      method: 'POST',
      body: JSON.stringify({ session_id: 'sess-T' }),
    });
    let settled = false;
    void waited.then(() => (settled = true)).catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    ac.abort();
    await waited.catch(() => {});
  });

  it('rejects on timeout', async () => {
    server = await startStopHookServer();
    await expect(
      server.awaitStop('sess-E', new AbortController().signal, 20),
    ).rejects.toThrow(/timed out/);
  });
});
