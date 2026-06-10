// Localhost bridge that turns Claude Code's `Stop` hook into an awaitable
// promise. The PTY transport needs to know "this turn just ended" but the TUI
// gives no clean machine signal on stdout. Claude *does* fire a Stop hook at the
// end of every main-agent turn, passing the hook a JSON payload (incl.
// `session_id`) on stdin. We install — only in a temp `--settings` file, never
// the user's global ~/.claude/settings.json — a Stop hook whose command forwards
// that payload to this server. awaitStop(sessionId) resolves when it arrives.
//
// Hardening: bound to loopback only, ephemeral port, 1 MB body cap, and a random
// per-server token baked into the URL path so another local process can't forge
// a turn completion (the token only travels through the temp settings command).

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The fields we read out of Claude Code's Stop-hook JSON payload (verified
 * against a real hook fire). `lastAssistantMessage` is the just-completed turn's
 * reply text — the terminal-mode dispatch path returns it directly without
 * re-reading the transcript. `raw` keeps the full object for forward-compat.
 */
export interface StopHookPayload {
  sessionId: string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  effortLevel?: string;
  raw: Record<string, unknown>;
}

interface PendingWaiter {
  resolve: (payload: StopHookPayload) => void;
  reject: (err: Error) => void;
}

export interface StopHookServer {
  /** POST URL the Stop-hook forwarder should hit (carries the secret token). */
  url(): string;
  /**
   * Resolve with the Stop-hook payload when the next hook for `sessionId` fires.
   * If a hook already fired since the last consume (race where the turn ended
   * before we armed), resolves immediately with the buffered payload. Rejects on
   * abort or timeout.
   */
  awaitStop(sessionId: string, signal: AbortSignal, timeoutMs?: number): Promise<StopHookPayload>;
  /** Drop a session's bookkeeping (call on dispose) so the maps don't leak. */
  release(sessionId: string): void;
  close(): Promise<void>;
}

function parsePayload(body: string): StopHookPayload | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
  if (!sessionId) return null;
  const effort = raw.effort as { level?: unknown } | undefined;
  return {
    sessionId,
    transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
    lastAssistantMessage:
      typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : undefined,
    effortLevel: effort && typeof effort.level === 'string' ? effort.level : undefined,
    raw,
  };
}

export async function startStopHookServer(): Promise<StopHookServer> {
  // One waiter at a time per session (turns are serialized), but we keep a
  // queue + a "fired before armed" flag to make the arm/fire order race-free.
  const waiters = new Map<string, PendingWaiter[]>();
  // Capped at one buffered pre-arm fire per session: a real Stop hook fires at
  // the end of every turn, so an *uncapped* counter would let stale completions
  // accumulate and a later arm would consume turn N-1's signal for turn N.
  const firedAhead = new Map<string, StopHookPayload>();
  // Random token; only the spawned claude (via temp settings) learns it.
  const token = randomUUID();
  const stopPath = `/stop/${token}`;

  function deliver(payload: StopHookPayload): void {
    const q = waiters.get(payload.sessionId);
    if (q && q.length > 0) {
      q.shift()!.resolve(payload);
      return;
    }
    firedAhead.set(payload.sessionId, payload);
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== stopPath) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    let length = 0;
    req.on('data', (c: Buffer | string) => {
      length += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
      if (length > 1_000_000) {
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => {
      const payload = parsePayload(body);
      if (payload) {
        deliver(payload);
      } else {
        // A renamed field in a future CLI would silently time out every turn —
        // surface it once instead of leaving the user staring at a 5-min hang.
        console.warn('[claude-pty] Stop hook POST had no session_id; ignoring');
      }
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
      return `http://127.0.0.1:${port}${stopPath}`;
    },

    awaitStop(sessionId, signal, timeoutMs = 5 * 60_000): Promise<StopHookPayload> {
      // Consume a hook that fired before we armed.
      const buffered = firedAhead.get(sessionId);
      if (buffered) {
        firedAhead.delete(sessionId);
        return Promise.resolve(buffered);
      }
      if (signal.aborted) return Promise.reject(new Error('aborted'));

      return new Promise<StopHookPayload>((resolve, reject) => {
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
            if (list.length === 0) waiters.delete(sessionId);
          }
        }
        function done(payload: StopHookPayload) {
          cleanup();
          resolve(payload);
        }
        function fail(err: Error) {
          cleanup();
          reject(err);
        }
      });
    },

    release(sessionId: string): void {
      firedAhead.delete(sessionId);
      const q = waiters.get(sessionId);
      if (q) {
        for (const w of q) w.reject(new Error('session released'));
        waiters.delete(sessionId);
      }
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const [, q] of waiters) {
          for (const w of q) w.reject(new Error('server closed'));
        }
        waiters.clear();
        firedAhead.clear();
        server.close(() => resolve());
      });
    },
  };
}
