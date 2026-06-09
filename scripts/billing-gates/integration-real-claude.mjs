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

const run = claudePtyAdapter.run({
  cwd: process.cwd(),
  systemPrompt: '',
  abortController: new AbortController(),
  initialPrompt: { text: 'Reply with exactly: OK', images: [] },
});

console.log('→ driving real claude for one turn…\n');
const events = [];
try {
  for await (const ev of run.events) {
    events.push(ev);
    console.log('  ', JSON.stringify(ev));
    if (ev.type === 'turn_complete') run.close();
  }
} finally {
  await shutdownClaudePty?.();
}

const gotText = events.some((e) => e.type === 'text_delta');
const gotComplete = events.some((e) => e.type === 'turn_complete');
console.log(
  `\n[result] text_delta=${gotText} turn_complete=${gotComplete} → ` +
    (gotText && gotComplete ? 'MECHANISM WORKS ✓' : 'FAILED ✗ (tune submitToTui / transcript slug)'),
);
process.exit(gotText && gotComplete ? 0 : 1);
