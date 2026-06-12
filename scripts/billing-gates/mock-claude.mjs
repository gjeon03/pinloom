#!/usr/bin/env node
// A deterministic stand-in for the real `claude` interactive CLI, used to
// exercise the PTY transport (node-session.ts) end-to-end — pty spawn, the temp
// --settings Stop hook, transcript discovery/append, and turn read-back —
// WITHOUT a real claude binary, real auth, or any real usage. It speaks the
// exact contract node-session expects:
//
//   • on launch: create ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
//   • read bracketed-paste prompts (\e[200~ … \e[201~) terminated by CR
//   • per prompt: append a user line + an assistant "echo: <text>" line
//   • then run the Stop hook command from --settings, feeding it the hook
//     JSON ({session_id, transcript_path, hook_event_name:"Stop"}) on stdin
//
// Used by the gated integration test (PINLOOM_RUN_PTY_INTEGRATION=1) and handy
// for manual PTY plumbing checks. NOT a billing probe — see gate2/gate3 for that.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// The positional [prompt] is whatever argv element isn't a flag or a flag value.
const VALUE_FLAGS = new Set([
  '--settings',
  '--setting-sources',
  '--append-system-prompt',
  '--model',
  '--mcp-config',
  '--resume',
]);
function positionalPrompt() {
  const a = process.argv.slice(2);
  const positionals = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t.startsWith('--')) {
      if (VALUE_FLAGS.has(t)) i++; // skip its value
      continue;
    }
    positionals.push(t);
  }
  return positionals.length ? positionals[positionals.length - 1] : null;
}

const HOME = process.env.HOME || homedir();
const cwd = process.cwd();
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(HOME, '.claude', 'projects', slug);
mkdirSync(dir, { recursive: true });

const resume = argValue('--resume');
const sessionId = resume || `mock-${process.pid}-${Math.floor(performance.now())}`;
const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
const settingsPath = argValue('--settings');

let seq = 0;
let lastUuid = `boot-${sessionId}`;

function appendLine(obj) {
  appendFileSync(transcriptPath, JSON.stringify(obj) + '\n', 'utf8');
}

// Real claude creates the transcript on launch — do the same so
// discoverNewSessionFile() sees a fresh file appear.
if (!resume) {
  writeFileSync(transcriptPath, '', 'utf8');
  appendLine({ type: 'system', uuid: lastUuid, sessionId });
}

function fireStopHook() {
  if (!settingsPath) return;
  let command;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    command = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
  } catch {
    return;
  }
  if (!command) return;
  const hookInput = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    cwd,
  });
  const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.write(hookInput);
  child.stdin.end();
}

function handlePrompt(text) {
  const u = `u-${seq}`;
  const a = `a-${seq}`;
  seq += 1;
  appendLine({
    type: 'user',
    uuid: u,
    parentUuid: lastUuid,
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  });
  appendLine({
    type: 'assistant',
    uuid: a,
    parentUuid: u,
    sessionId,
    requestId: `req-${a}`,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: `echo: ${text}` }],
      usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    },
  });
  lastUuid = a;
  // Let the file write settle, then signal turn completion.
  setTimeout(fireStopHook, 10);
}

// Turn 1 may be seeded via the positional [prompt] arg (like real claude) —
// auto-run it on launch, mirroring the interactive-session behavior.
const seed = resume ? null : positionalPrompt();
if (seed) setTimeout(() => handlePrompt(seed), 20);

// Parse prompts out of the raw keystroke stream. A submission ends with CR (or
// LF); the text may be typed plainly or wrapped in bracketed paste — strip the
// paste markers and any stray CSI codes, then treat the line as the prompt.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.search(/[\r\n]/)) !== -1) {
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    line = line
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .trim();
    if (line) handlePrompt(line);
  }
});
process.stdin.on('end', () => process.exit(0));

// Keep the event loop alive.
process.stdin.resume();
