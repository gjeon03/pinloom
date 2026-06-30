// Fun stat: per-skill invocation counts. The AI invokes a skill via the `Skill`
// tool (tool_use { name: 'Skill', input: { skill: '<name>' } }); persistMessage
// records each new such call here. Counts are keyed by the tool's skill name
// (our slugs match; plugin/namespaced skills just key by their own id) and are
// surfaced as a badge on the Skills page. Forward-counting only.

import { getDb } from '../db/connection.js';

/** Increment a skill's invocation count. Called once per newly-persisted call. */
export function recordSkillUse(name: string, at = new Date().toISOString()): void {
  if (!name) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO skill_usage (name, count, last_used_at) VALUES (?, 1, ?)
         ON CONFLICT(name) DO UPDATE SET count = count + 1, last_used_at = excluded.last_used_at`,
      )
      .run(name, at);
  } catch {
    // best-effort: a usage stat must never break message persistence.
  }
}

export interface SkillUse {
  count: number;
  lastUsedAt: string | null;
}

/** name → {count, lastUsedAt} for joining into skill listings. */
export function getSkillUsage(): Map<string, SkillUse> {
  try {
    const rows = getDb()
      .prepare('SELECT name, count, last_used_at AS lastUsedAt FROM skill_usage')
      .all() as { name: string; count: number; lastUsedAt: string | null }[];
    return new Map(rows.map((r) => [r.name, { count: r.count, lastUsedAt: r.lastUsedAt }]));
  } catch {
    return new Map();
  }
}
