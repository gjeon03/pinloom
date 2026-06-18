// End-to-end dispatch into a worker terminal via the mock `claude` binary —
// no real claude/auth. Gated behind PINLOOM_RUN_PTY_INTEGRATION=1 (spawns a pty).

import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_RUNS_CHANNEL } from '@pinloom/shared';
import { getDb } from '../../db/connection.js';
import { dispatchToWorker, killAgentTerminal } from './agent-terminal.js';
import { shutdownStopHookServer } from './shared-server.js';
import { subscribe, unsubscribe } from '../../ws/hub.js';
import { projectDir } from './transcript.js';

const RUN = process.env.PINLOOM_RUN_PTY_INTEGRATION === '1';

// Minimal stand-in for a subscribed WebSocket: records the run_activity events
// the hub broadcasts so a test can assert the started/finished lifecycle.
function makeRunsRecorder() {
  const events: Array<{ type: string; sessionId?: string; phase?: string }> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => events.push(JSON.parse(payload)),
  };
  return { events, socket: socket as unknown as Parameters<typeof subscribe>[1] };
}

const mockClaude = fileURLToPath(
  new URL('../../../../../scripts/billing-gates/mock-claude.mjs', import.meta.url),
);

describe.runIf(RUN)('agent-terminal dispatch (mock claude over pty)', () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await shutdownStopHookServer();
    delete process.env.PINLOOM_CLAUDE_BIN;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  });

  it('cold-starts a worker, seeds the prompt, and returns last_assistant_message', async () => {
    chmodSync(mockClaude, 0o755);
    process.env.PINLOOM_CLAUDE_BIN = mockClaude;
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'agt-it-')));
    cleanups.push(cwd, projectDir(cwd));

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('p-disp', 'd', cwd, now, now);
    db.prepare(
      'INSERT INTO sessions (id,project_id,agent,transport,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run('s-disp', 'p-disp', 'claude', 'terminal', now, now);

    const ac = new AbortController();
    const result = await dispatchToWorker('s-disp', 'hello worker', ac.signal, 20_000);
    killAgentTerminal('s-disp');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe('echo: hello worker');
  }, 25_000);

  // Regression for the terminal running-indicator (PR #115): a terminal turn
  // must emit run_activity `started` (not just `finished`), or the tab dot and
  // the bell's "In progress" list — both keyed off run_activity — never light
  // up for terminal work.
  it('emits run_activity started + finished for a terminal turn', async () => {
    chmodSync(mockClaude, 0o755);
    process.env.PINLOOM_CLAUDE_BIN = mockClaude;
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'agt-run-')));
    cleanups.push(cwd, projectDir(cwd));

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('p-run', 'd', cwd, now, now);
    db.prepare(
      'INSERT INTO sessions (id,project_id,agent,transport,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run('s-run', 'p-run', 'claude', 'terminal', now, now);

    const { events, socket } = makeRunsRecorder();
    subscribe(WS_RUNS_CHANNEL, socket);
    try {
      const ac = new AbortController();
      const result = await dispatchToWorker('s-run', 'hello', ac.signal, 20_000);
      killAgentTerminal('s-run');
      expect(result.ok).toBe(true);

      const phases = events
        .filter((e) => e.type === 'run_activity' && e.sessionId === 's-run')
        .map((e) => e.phase);
      // The turn must announce a start (the bug #115 fixed) and an end.
      expect(phases).toContain('started');
      expect(phases).toContain('finished');
      // started must precede finished.
      expect(phases.indexOf('started')).toBeLessThan(phases.lastIndexOf('finished'));
    } finally {
      unsubscribe(WS_RUNS_CHANNEL, socket);
    }
  }, 25_000);
});
