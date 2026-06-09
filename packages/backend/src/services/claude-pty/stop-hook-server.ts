// Localhost bridge that turns Claude Code's `Stop` hook into an awaitable
// promise. The PTY transport needs to know "this turn just ended" but the TUI
// gives no clean machine signal on stdout. Claude *does* fire a Stop hook at the
// end of every main-agent turn, passing the hook a JSON payload (incl.
// `session_id`) on stdin. We install — only in a temp `--settings` file, never
// the user's global ~/.claude/settings.json — a Stop hook whose command forwards
// that payload to this server. awaitStop(sessionId) resolves when it arrives.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface PendingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface StopHookServer {
  /** POST URL the Stop-hook forwarder should hit. */
  url(): string;
  /**
   * Resolve when the next Stop hook for `sessionId` fires. If a hook already
   * fired since the last consume (race where the turn ended before we armed),
   * resolves immediately. Rejects on abort or timeout.
   */
  awaitStop(sessionId: string, signal: AbortSignal, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startStopHookServer(): Promise<StopHookServer> {
  // One waiter at a time per session (turns are serialized), but we keep a
  // queue + a "fired before armed" counter to make the arm/fire order
  // race-free.
  const waiters = new Map<string, PendingWaiter[]>();
  const firedAhead = new Map<string, number>();

  function deliver(sessionId: string): void {
    const q = waiters.get(sessionId);
    if (q && q.length > 0) {
      const w = q.shift()!;
      w.resolve();
      return;
    }
    firedAhead.set(sessionId, (firedAhead.get(sessionId) ?? 0) + 1);
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      // Guard against an unbounded body (hook payloads are tiny).
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let sessionId = '';
      try {
        const payload = JSON.parse(body || '{}') as { session_id?: string };
        sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
      } catch {
        // ignore malformed payloads
      }
      if (sessionId) deliver(sessionId);
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Ephemeral port on loopback only — never exposed off-box.
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();

  const port = (server.address() as AddressInfo).port;

  return {
    url(): string {
      return `http://127.0.0.1:${port}/stop`;
    },

    awaitStop(sessionId, signal, timeoutMs = 5 * 60_000): Promise<void> {
      // Consume a hook that fired before we armed.
      const ahead = firedAhead.get(sessionId) ?? 0;
      if (ahead > 0) {
        firedAhead.set(sessionId, ahead - 1);
        return Promise.resolve();
      }
      if (signal.aborted) return Promise.reject(new Error('aborted'));

      return new Promise<void>((resolve, reject) => {
        const q = waiters.get(sessionId) ?? [];
        const waiter: PendingWaiter = { resolve: done, reject: fail };
        q.push(waiter);
        waiters.set(sessionId, q);

        const timer = setTimeout(
          () => fail(new Error(`Stop hook timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        const onAbort = () => fail(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });

        function cleanup() {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          const list = waiters.get(sessionId);
          if (list) {
            const i = list.indexOf(waiter);
            if (i !== -1) list.splice(i, 1);
          }
        }
        function done() {
          cleanup();
          resolve();
        }
        function fail(err: Error) {
          cleanup();
          reject(err);
        }
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const [, q] of waiters) {
          for (const w of q) w.reject(new Error('server closed'));
        }
        waiters.clear();
        server.close(() => resolve());
      });
    },
  };
}
