#!/usr/bin/env node
// REAL-claude mechanism check for the PTY transport. Drives an actual
// interactive `claude` REPL through the built claude-pty adapter for ONE tiny
// turn and prints the NormalizedEvent stream. Validates everything the mock
// can't about the real binary: exact submit keystrokes, the transcript slug,
// that the Stop hook fires per turn, and that turn extraction matches real
// output. (Which billing BUCKET it lands in is gate 2/3, not this.)
//
//   ⚠️  CONSUMES REAL USAGE (one short turn). Refuses without PINLOOM_GATE_CONFIRM=1.
//   Prereq: build first so dist/ exists →  pnpm --filter @pinloom/backend build
//
// Run:
//   pnpm --filter @pinloom/backend build
//   PINLOOM_GATE_CONFIRM=1 node scripts/billing-gates/integration-real-claude.mjs

import { pathToFileURL } from 'node:url';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.env.PINLOOM_GATE_CONFIRM !== '1') {
  console.error(
    'Refusing: this drives real `claude` and consumes a little real usage.\n' +
      'Build, then re-run with PINLOOM_GATE_CONFIRM=1:\n' +
      '  pnpm --filter @pinloom/backend build\n' +
      '  PINLOOM_GATE_CONFIRM=1 node scripts/billing-gates/integration-real-claude.mjs',
  );
  process.exit(2);
}

const distUrl = pathToFileURL(
  path.resolve(
    process.cwd(),
    'packages/backend/dist/services/claude-pty/index.js',
  ),
).href;

let mod;
try {
  mod = await import(distUrl);
} catch (err) {
  console.error(
    `Could not import the built adapter at\n  ${distUrl}\n` +
      'Run `pnpm --filter @pinloom/backend build` first.\n\n' +
      String(err),
  );
  process.exit(1);
}

const { claudePtyAdapter, shutdownClaudePty } = mod;

// Use a throwaway cwd so the new transcript is unambiguous (avoids colliding
// with any claude already running in your project dir). realpathSync resolves
// macOS's /var -> /private/var so the slug matches claude's resolved cwd.
const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'pinloom-pty-real-')));

const run = claudePtyAdapter.run({
  cwd,
  systemPrompt: '',
  abortController: new AbortController(),
  initialPrompt: { text: 'Reply with exactly: OK', images: [] },
});

// Two turns: turn 1 is seeded via the positional arg, turn 2 is injected as
// keystrokes into the now-settled TUI — so this validates BOTH input paths.
console.log(`→ driving real claude for two turns (cwd=${cwd})…\n`);
const events = [];
let turns = 0;
try {
  for await (const ev of run.events) {
    events.push(ev);
    console.log('  ', JSON.stringify(ev));
    if (ev.type === 'turn_complete') {
      turns += 1;
      if (turns === 1) {
        console.log('\n→ turn 1 done; injecting turn 2…\n');
        run.pushMessage({ text: 'Now reply with exactly: TWO', images: [] });
      } else {
        run.close();
      }
    }
  }
} finally {
  await shutdownClaudePty?.();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

const texts = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
const completes = events.filter((e) => e.type === 'turn_complete').length;
const ok = texts.length >= 2 && completes >= 2;
console.log(
  `\n[result] turns=${completes} texts=${JSON.stringify(texts)} → ` +
    (ok ? 'MULTI-TURN MECHANISM WORKS ✓' : 'turn 1 ok, turn 2 (injection) needs tuning ✗'),
);
process.exit(ok ? 0 : 1);
