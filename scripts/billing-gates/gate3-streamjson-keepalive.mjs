#!/usr/bin/env node
// GATE 3 (run ON/AFTER 2026-06-15 only) — does a long-lived
// `claude -p --input-format stream-json --output-format stream-json` session
// (the SDK is essentially this wrapper) bill the interactive bucket? If yes, we
// get keep-alive + structured I/O WITHOUT the fragile TUI keystroke driving —
// strictly better than the PTY path. Only meaningful if gate 2 was inconclusive
// or you want the robust structured route confirmed.
//
//   ⚠️  CONSUMES REAL USAGE. Refuses without PINLOOM_GATE_CONFIRM=1.
//   ⚠️  Meaningless before 2026-06-15.
//
// Method: record balances → run (feeds two prompts over one stdin-stream
// session) → re-check which bucket decremented.

import { spawn } from 'node:child_process';

if (process.env.PINLOOM_GATE_CONFIRM !== '1') {
  console.error(
    'Refusing: consumes real usage. On/after 2026-06-15:\n' +
      '  PINLOOM_GATE_CONFIRM=1 node scripts/billing-gates/gate3-streamjson-keepalive.mjs',
  );
  process.exit(2);
}

const bin = process.env.PINLOOM_CLAUDE_BIN ?? 'claude';
const child = spawn(
  bin,
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => process.stdout.write(d));

// stream-json input: one JSON user message per line.
function send(text) {
  child.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
  );
}
send('Reply with exactly: ONE');
setTimeout(() => send('Reply with exactly: TWO'), 4000);
setTimeout(() => child.stdin.end(), 8000);

child.on('close', (code) => {
  console.log(`\n\n[done] exit=${code}`);
  console.log(
    'Re-check `claude /status`. If the interactive/weekly bucket decremented and\n' +
      'both turns streamed structured events, this is the preferred transport —\n' +
      'robust keep-alive without TUI keystrokes. Record the result in the plan.',
  );
});
