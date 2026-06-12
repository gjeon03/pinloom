// End-to-end exercise of the REAL node-pty transport (node-session.ts) against
// a deterministic mock `claude` binary — no real claude, auth, or usage. Proves
// the fragile integration the unit tests can't: pty spawn, temp --settings Stop
// hook firing over localhost, transcript discovery + append, and turn read-back.
//
// Gated behind PINLOOM_RUN_PTY_INTEGRATION=1 so the default `pnpm test` stays
// fast and free of pty/process flakiness in constrained CI. Run locally with:
//   PINLOOM_RUN_PTY_INTEGRATION=1 pnpm --filter @pinloom/backend test \
//     src/services/claude-pty/node-session.integration.test.ts
//
// We isolate by using a fresh temp CWD (its unique transcript slug keeps real
// ~/.claude sessions untouched) rather than overriding $HOME — overriding HOME
// breaks `node` resolution under version managers (asdf reads $HOME/.tool-versions).

import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeClaudeSessionFactory, shutdownClaudePty } from './node-session.js';
import { createClaudePtyAdapter } from './claude-pty-adapter.js';
import { projectDir } from './transcript.js';
import type { NormalizedEvent } from '../agents/types.js';

const RUN = process.env.PINLOOM_RUN_PTY_INTEGRATION === '1';

const mockClaude = fileURLToPath(
  new URL('../../../../../scripts/billing-gates/mock-claude.mjs', import.meta.url),
);

describe.runIf(RUN)('node-session integration (mock claude over pty)', () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await shutdownClaudePty();
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  });

  it('drives two turns (seed + injection) through pty + stop hook + transcript', async () => {
    chmodSync(mockClaude, 0o755);
    // Fresh CWD → unique transcript slug under the real ~/.claude/projects.
    // realpathSync resolves macOS's /var -> /private/var symlink so the slug we
    // compute matches the one the child derives from its resolved process.cwd().
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'pinloom-pty-it-')));
    cleanups.push(cwd, projectDir(cwd));

    const factory = createNodeClaudeSessionFactory({ claudeBin: mockClaude });
    const adapter = createClaudePtyAdapter(factory);
    const run = adapter.run({
      cwd,
      systemPrompt: '',
      abortController: new AbortController(),
      initialPrompt: { text: 'hello world', images: [] },
    });

    const events: NormalizedEvent[] = [];
    let turns = 0;
    for await (const ev of run.events) {
      events.push(ev);
      if (ev.type === 'turn_complete') {
        turns += 1;
        if (turns === 1) run.pushMessage({ text: 'second turn', images: [] });
        else run.close();
      }
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'echo: hello world' }); // seeded
    expect(events).toContainEqual({ type: 'text_delta', text: 'echo: second turn' }); // injected
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(2);
    expect(events.some((e) => e.type === 'session_id')).toBe(true);
  }, 30_000);
});
