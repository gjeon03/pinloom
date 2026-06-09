// Token accounting over transcript lines. Pure + I/O-free so it serves both
// the 6/15 gate-1 spend estimate (scripts/billing-gates/measure-sdk-spend.mjs)
// and the future usage progress bar (issue #21). Synthetic + sidechain-free
// counting matches what Anthropic bills.

import { SYNTHETIC_MODEL, type JsonlLine } from './types.js';

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of billed assistant messages counted. */
  messages: number;
}

export interface UsageBreakdown {
  total: TokenTotals;
  /** Per-model totals, keyed by the model id Claude reported. */
  byModel: Record<string, TokenTotals>;
  /** Per-UTC-day totals, keyed by YYYY-MM-DD. */
  byDay: Record<string, TokenTotals>;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    messages: 0,
  };
}

function add(into: TokenTotals, line: JsonlLine): void {
  const u = line.message?.usage;
  if (!u) return;
  into.inputTokens += u.input_tokens ?? 0;
  into.outputTokens += u.output_tokens ?? 0;
  into.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  into.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  into.messages += 1;
}

function dayOf(timestamp: string | undefined): string {
  if (!timestamp) return 'unknown';
  // ISO-8601 → YYYY-MM-DD (UTC). Defensive: bail to 'unknown' on garbage.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
  return m ? m[1] : 'unknown';
}

/**
 * Aggregate token usage across transcript lines. Only counts billed assistant
 * messages: skips sidechain (subagent) turns and synthetic (compaction/error)
 * messages, which Anthropic does not bill against the user the same way.
 */
export function aggregateUsage(lines: JsonlLine[]): UsageBreakdown {
  const total = emptyTotals();
  const byModel: Record<string, TokenTotals> = {};
  const byDay: Record<string, TokenTotals> = {};

  for (const line of lines) {
    if (line.type !== 'assistant') continue;
    if (line.isSidechain) continue;
    const model = line.message?.model;
    if (!model || model === SYNTHETIC_MODEL) continue;
    if (!line.message?.usage) continue;

    add(total, line);

    (byModel[model] ??= emptyTotals());
    add(byModel[model], line);

    const day = dayOf(line.timestamp);
    (byDay[day] ??= emptyTotals());
    add(byDay[day], line);
  }

  return { total, byModel, byDay };
}
