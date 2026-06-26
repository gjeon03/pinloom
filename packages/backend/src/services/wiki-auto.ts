// Auto wiki generation (the "knowledge flywheel" for L2). A background sweep
// periodically re-runs the conventions analyzer per project and STAGES the
// result as a `replace_page` proposal — the human accept gate stays, because the
// wiki is injected into every system prompt and auto-written content would
// otherwise silently steer every future turn.
//
// Conservative by construction so it never floods the inbox or burns tokens:
//   • per-project opt-out (`projects.wiki_auto`, default on)
//   • only when the project is idle (no live conversation)
//   • only after ≥ DELTA new messages accrued since the last run
//   • at most once per project per MIN_INTERVAL (a day)
//   • skipped if a pending conventions proposal already exists (≤1 per project)
//   • one analyze per tick — spreads the LLM cost across the fleet
// Mirrors the timeline capture sweep: single timer, single-flight, unref'd,
// gated off in tests (started from app.ts only when NODE_ENV !== 'test').

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { isAnalyzing, runConventionsAnalysis } from './wiki-analyzer.js';

const SWEEP_INTERVAL_MS = 10 * 60_000; // re-check the fleet every 10 min
const IDLE_MS = 15 * 60_000; // skip projects with activity in the last 15 min
const MIN_INTERVAL_MS = 24 * 60 * 60_000; // ≥ a day between runs per project
const DELTA = 20; // new user/assistant messages required to re-analyze

interface Candidate {
  projectId: string;
  newSince: number;
}

/** Pick the single most-overdue eligible project (or null). Exported for tests. */
export function pickAutoAnalyzeTarget(db: Database, nowMs: number): Candidate | null {
  const projects = db
    .prepare('SELECT id FROM projects WHERE hidden = 0 AND wiki_auto = 1')
    .all() as { id: string }[];

  const activityStmt = db.prepare(
    `SELECT MAX(m.created_at) AS latest,
            SUM(CASE WHEN m.created_at > ? THEN 1 ELSE 0 END) AS newSince,
            COUNT(*) AS total
       FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.project_id = ? AND m.role IN ('user','assistant') AND m.content <> ''`,
  );
  const stateStmt = db.prepare(
    'SELECT last_run_at FROM wiki_analyze_state WHERE project_id = ?',
  );
  const pendingStmt = db.prepare(
    "SELECT 1 FROM wiki_proposals WHERE status = 'pending' AND rel_path = ? LIMIT 1",
  );

  let best: Candidate | null = null;
  for (const p of projects) {
    const lastRunAt = (stateStmt.get(p.id) as { last_run_at: string | null } | undefined)?.last_run_at ?? '';
    const act = activityStmt.get(lastRunAt, p.id) as {
      latest: string | null;
      newSince: number | null;
      total: number;
    };
    if (act.total === 0 || !act.latest) continue; // no work
    const latestMs = new Date(act.latest).getTime();
    if (Number.isNaN(latestMs) || nowMs - latestMs < IDLE_MS) continue; // mid-conversation / bad data
    if (lastRunAt) {
      const lastRunMs = new Date(lastRunAt).getTime();
      // Fail CLOSED on a malformed timestamp — never analyze on untrusted state.
      if (Number.isNaN(lastRunMs) || nowMs - lastRunMs < MIN_INTERVAL_MS) continue; // too soon
    }
    const newSince = act.newSince ?? 0;
    if (newSince < DELTA) continue; // not enough new material
    if (isAnalyzing(p.id)) continue;
    const relPath = `conventions-${getProjectWikiSlugByProjectId(p.id)}.md`;
    if (pendingStmt.get(relPath)) continue; // unreviewed proposal already waiting
    if (!best || newSince > best.newSince) best = { projectId: p.id, newSince };
  }
  return best;
}

function markRun(db: Database, projectId: string, nowIso: string): void {
  // `last_run_at` is the cursor for both the interval gate and the "new messages
  // since" delta count. (last_message_at exists in the table but is unused.)
  db.prepare(
    `INSERT INTO wiki_analyze_state (project_id, last_run_at) VALUES (?, ?)
     ON CONFLICT(project_id) DO UPDATE SET last_run_at = excluded.last_run_at`,
  ).run(projectId, nowIso);
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (running) return; // single-flight
  running = true;
  try {
    const db = getDb();
    const target = pickAutoAnalyzeTarget(db, Date.now());
    if (!target) return;
    // Stamp the run BEFORE the slow LLM call so a failure doesn't make us retry
    // the same project every tick (the interval gate now holds it for a day).
    markRun(db, target.projectId, new Date().toISOString());
    await runConventionsAnalysis(target.projectId, { stageProposal: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[wiki-auto] sweep failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startWikiAuto(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWikiAuto(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}
