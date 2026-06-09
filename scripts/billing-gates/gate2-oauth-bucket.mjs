#!/usr/bin/env node
// GATE 2 (run ON/AFTER 2026-06-15 only) — does `claude -p` on an OAuth
// subscription token bill the INTERACTIVE (weekly) bucket or the separate $200
// Agent-SDK credit bucket? This is THE pivotal experiment: if OAuth `-p` is the
// interactive bucket, the whole TUI-PTY machinery is unnecessary — pinloom just
// switches auth + routing. If it's the SDK bucket, the PTY transport is the path.
//
//   ⚠️  CONSUMES REAL USAGE. Refuses to run without PINLOOM_GATE_CONFIRM=1.
//   ⚠️  Meaningless before 2026-06-15 (buckets aren't split yet).
//
// Method (semi-manual — bucket attribution lives in the dashboard, not stdout):
//   1. Note your interactive + SDK-credit balances (claude /status, or the
//      Anthropic console usage page).
//   2. Run this — it fires a single tiny `claude -p` turn with the OAuth token.
//   3. Re-check both balances. Whichever decremented is the bucket `-p` used.

import { spawn } from 'node:child_process';

if (process.env.PINLOOM_GATE_CONFIRM !== '1') {
  console.error(
    'Refusing: this consumes real usage. Re-run on/after 2026-06-15 with\n' +
      '  PINLOOM_GATE_CONFIRM=1 node scripts/billing-gates/gate2-oauth-bucket.mjs\n' +
      'First record your interactive + SDK-credit balances (claude /status).',
  );
  process.exit(2);
}

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
console.log(
  token
    ? '→ CLAUDE_CODE_OAUTH_TOKEN is set; -p should use the subscription OAuth path.'
    : '⚠ CLAUDE_CODE_OAUTH_TOKEN not set — make sure you are NOT falling back to ANTHROPIC_API_KEY\n' +
        '  (that would bill the API/SDK bucket regardless). Check `claude /status`.',
);

const bin = process.env.PINLOOM_CLAUDE_BIN ?? 'claude';
console.log(`→ firing a single tiny turn: ${bin} -p --output-format stream-json …\n`);

const child = spawn(
  bin,
  ['-p', '--output-format', 'stream-json', '--verbose', 'Reply with exactly: OK'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => process.stdout.write(d));
child.on('close', (code) => {
  console.log(`\n\n[done] exit=${code}`);
  console.log(
    'Now re-check `claude /status` (or the console usage page). The bucket that\n' +
      'dropped is where OAuth `-p` bills:\n' +
      '  • interactive/weekly dropped  → PTY NOT needed. Build a `claude -p` adapter\n' +
      '    (clone codex-adapter) + workload routing. Update docs/billing/dual-bucket-plan.md.\n' +
      '  • $200 SDK credit dropped     → PTY transport IS the path. The tested\n' +
      "    claude-pty modules are ready; wire them live (see plan §6).",
  );
});
