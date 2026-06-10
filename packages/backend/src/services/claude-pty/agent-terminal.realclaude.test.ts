// Real-claude smoke for the terminal-mode dispatch path (teams). Gated behind
// PINLOOM_RUN_REAL_CLAUDE_DISPATCH=1 — drives REAL claude, consumes a little
// real usage. Pre-trusts the temp cwd so claude doesn't show the folder-trust
// dialog (agent-terminal has no auto-accept; the human handles it in the UI).

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { dispatchToWorker, killAgentTerminal } from './agent-terminal.js';
import { shutdownStopHookServer } from './shared-server.js';
import { projectDir } from './transcript.js';

const RUN = process.env.PINLOOM_RUN_REAL_CLAUDE_DISPATCH === '1';

function preTrust(cwd: string): void {
  const f = path.join(homedir(), '.claude.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.projects = j.projects || {};
  j.projects[cwd] = {
    ...(j.projects[cwd] || {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  writeFileSync(f, JSON.stringify(j));
}

describe.runIf(RUN)('agent-terminal dispatch — REAL claude', () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await shutdownStopHookServer();
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  });

  it('cold-starts a real claude worker, seeds the prompt, returns the reply', async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'agt-real-')));
    preTrust(cwd);
    cleanups.push(cwd, projectDir(cwd));

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES (?,?,?,?,?)').run(
      'p-real',
      'r',
      cwd,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO sessions (id,project_id,agent,transport,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run('s-real', 'p-real', 'claude', 'terminal', now, now);

    const ac = new AbortController();
    const result = await dispatchToWorker('s-real', 'Reply with exactly: PONG', ac.signal, 90_000);

    // eslint-disable-next-line no-console
    console.log('[real-claude dispatch] result =', JSON.stringify(result));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.toUpperCase()).toContain('PONG');

    // Capture runs async off the same Stop hook + retries for the assistant
    // flush — poll briefly for the persisted assistant row before asserting.
    const msgsOf = () =>
      db
        .prepare("SELECT role, content FROM messages WHERE session_id='s-real' ORDER BY rowid")
        .all() as { role: string; content: string }[];
    for (let i = 0; i < 50 && !msgsOf().some((m) => m.role === 'assistant'); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const msgs = msgsOf();
    killAgentTerminal('s-real');
    console.log('[real-claude dispatch] captured rows =', JSON.stringify(msgs));
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  }, 100_000);
});
