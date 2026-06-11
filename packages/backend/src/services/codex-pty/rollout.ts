// Discover + read a codex session's interactive rollout file. Because pinloom
// owns the per-session CODEX_HOME, the rollout lives under a KNOWN path
// (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl) and there's only
// the one this session writes — no shared-dir discovery race like claude.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseRolloutText, type CodexRolloutLine } from '../codex-rollout/parse.js';

/** Newest rollout-*.jsonl under <codexHome>/sessions, or null if none yet. */
export function findRollout(codexHome: string): string | null {
  const root = path.join(codexHome, 'sessions');
  let best: { p: string; m: number } | null = null;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
        if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs };
      }
    }
  };
  walk(root);
  return best ? (best as { p: string }).p : null;
}

export function readRolloutLines(file: string): CodexRolloutLine[] {
  try {
    return parseRolloutText(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
