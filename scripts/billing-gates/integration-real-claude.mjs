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

// Drive one run for N turns. `onComplete(turnIdx)` returns the next prompt to
// inject, or null to close the run.
async function driveRun(runArgs, onComplete) {
  const run = claudePtyAdapter.run(runArgs);
  const events = [];
  let turns = 0;
  let t0 = Date.now();
  for await (const ev of run.events) {
    events.push(ev);
    const dt = Date.now() - t0;
    console.log(`  +${String(dt).padStart(6)}ms`, JSON.stringify(ev));
    if (ev.type === 'text_delta' || ev.type === 'turn_complete') t0 = Date.now();
    if (ev.type === 'turn_complete') {
      turns += 1;
      const next = onComplete(turns);
      if (next) run.pushMessage(next);
      else run.close();
    }
  }
  return events;
}

const textsOf = (events) => events.filter((e) => e.type === 'text_delta').map((e) => e.text);
const sidOf = (events) => events.find((e) => e.type === 'session_id')?.id;

let allOk = true;
try {
  // PHASE 1 — fresh session: turn 1 seeded via positional arg, turn 2 injected
  // as keystrokes into the now-settled TUI. Validates both input paths.
  console.log(`→ phase 1: fresh session, two turns (cwd=${cwd})…\n`);
  const ev1 = await driveRun(
    {
      cwd,
      systemPrompt: '',
      abortController: new AbortController(),
      initialPrompt: { text: 'Reply with exactly: OK', images: [] },
    },
    (turn) => (turn === 1 ? { text: 'Now reply with exactly: TWO', images: [] } : null),
  );
  const sid = sidOf(ev1);
  const t1 = textsOf(ev1);
  const phase1Ok = t1.length >= 2 && !!sid;
  allOk = allOk && phase1Ok;
  console.log(`\n[phase 1] sid=${sid} texts=${JSON.stringify(t1)} → ${phase1Ok ? '✓' : '✗'}\n`);

  // PHASE 2 — resume that session in a SEPARATE run (as pinloom does after a run
  // ends / on reopen). The prompt is seeded via `claude --resume <id> "prompt"`.
  if (sid) {
    console.log(`→ phase 2: resume ${sid} with a new prompt…\n`);
    const ev2 = await driveRun(
      {
        cwd,
        systemPrompt: '',
        resume: sid,
        abortController: new AbortController(),
        initialPrompt: { text: 'Reply with exactly: THREE', images: [] },
      },
      () => null,
    );
    const t2 = textsOf(ev2);
    const phase2Ok = t2.length >= 1;
    allOk = allOk && phase2Ok;
    console.log(`\n[phase 2 resume] texts=${JSON.stringify(t2)} → ${phase2Ok ? '✓' : '✗'}`);
  }
} finally {
  await shutdownClaudePty?.();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

console.log(`\n[result] → ${allOk ? 'FRESH + RESUME MECHANISM WORKS ✓' : 'NEEDS TUNING ✗'}`);
process.exit(allOk ? 0 : 1);
