#!/usr/bin/env node
// Stage 0 / Gate 1 — estimate current Claude usage from local transcripts.
// READ-ONLY: reads ~/.claude/projects/**/*.jsonl and sums billed tokens. Safe to
// run today (no usage consumed). Output feeds the 6/15 decision: if your monthly
// spend proxy is already under the $200 SDK credit cap, the PTY project is
// unnecessary (gate 1 passes) and Stage 0 model-diet alone suffices.
//
// Usage:
//   node scripts/billing-gates/measure-sdk-spend.mjs [--days 30] [--json]
//
// Caveat: token $-cost here is a PROXY using rough public list prices, not your
// actual SDK-credit consumption (Anthropic meters that differently). Use it to
// compare order-of-magnitude against $200, not as an invoice.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const days = Number(args[(args.indexOf('--days') + 1) || -1]) || 30;
const asJson = args.includes('--json');

const SYNTHETIC = '<synthetic>';
// Rough public list prices, USD per million tokens. Keyed by model-id substring.
const RATES = [
  { match: 'opus', in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { match: 'sonnet', in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { match: 'haiku', in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
];
function rateFor(model) {
  return RATES.find((r) => model.includes(r.match)) ?? RATES[0];
}

const projectsDir = path.join(homedir(), '.claude', 'projects');
if (!existsSync(projectsDir)) {
  console.error(`No ~/.claude/projects at ${projectsDir}`);
  process.exit(1);
}

const since = Date.now() - days * 24 * 60 * 60 * 1000;
const totals = {};
let messages = 0;
let estCost = 0;

function addModel(model, u) {
  const t = (totals[model] ??= { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 });
  t.in += u.input_tokens ?? 0;
  t.out += u.output_tokens ?? 0;
  t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  t.cacheRead += u.cache_read_input_tokens ?? 0;
  t.msgs += 1;
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.jsonl')) scan(p);
  }
}

function scan(file) {
  // Skip files untouched in the window — cheap pre-filter.
  try {
    if (statSync(file).mtimeMs < since) return;
  } catch {
    return;
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const msg = o.message;
    const model = msg?.model;
    if (!model || model === SYNTHETIC || !msg.usage) continue;
    if (o.timestamp && Date.parse(o.timestamp) < since) continue;
    addModel(model, msg.usage);
    messages += 1;
  }
}

walk(projectsDir);

for (const [model, t] of Object.entries(totals)) {
  const r = rateFor(model);
  estCost +=
    (t.in * r.in + t.out * r.out + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead) /
    1_000_000;
}

if (asJson) {
  console.log(JSON.stringify({ days, messages, estCostUsd: estCost, totals }, null, 2));
} else {
  console.log(`\nClaude usage over the last ${days} days (local transcripts)\n`);
  const fmt = (n) => n.toLocaleString('en-US');
  for (const [model, t] of Object.entries(totals)) {
    console.log(`  ${model}`);
    console.log(
      `    msgs=${fmt(t.msgs)}  in=${fmt(t.in)}  out=${fmt(t.out)}  ` +
        `cacheWrite=${fmt(t.cacheWrite)}  cacheRead=${fmt(t.cacheRead)}`,
    );
  }
  console.log(`\n  total billed assistant messages: ${fmt(messages)}`);
  console.log(`  rough $-cost proxy: ~$${estCost.toFixed(2)} (list-price estimate, NOT your invoice)`);
  console.log(`  $200 SDK credit cap reference: ${estCost > 200 ? 'OVER ⚠️' : 'under ✓'}\n`);
  console.log('  → Gate 1: if this is comfortably under $200/mo, the PTY build is unnecessary.');
  console.log('    Re-run with --days 30 right before 6/15 for the decision input.\n');
}
