// Auto session→wiki sync (the conversation half of the knowledge flywheel).
// The conventions auto-sweep (wiki-auto.ts) distills the CODEBASE; this distills
// the CONVERSATIONS — capturing domain/product knowledge that never appears in
// code. Same shape as wiki-auto: a single unref'd timer, single-flight, gated
// off in tests, and every change lands as a REVIEWABLE proposal (the session
// cursor only advances when the human accepts).
//
// Conservative by construction:
//   • per-project opt-out (`projects.wiki_auto`, shared with conventions)
//   • only idle sessions (no live conversation)
//   • only after ≥ DELTA new (unsynced) user/assistant messages
//   • skipped while an unreviewed sync proposal for the session is pending
//   • skipped for MIN_INTERVAL after an attempt (breaks a reject → re-propose loop)
//   • one session per tick — spreads the LLM cost across the fleet

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getDb } from '../db/connection.js';
import { getUiConfig } from './ui-config.js';
import { runSandboxedSync } from './wiki-sync.js';
import { createProposal } from './wiki-proposals.js';

const SWEEP_INTERVAL_MS = 10 * 60_000; // re-check the fleet every 10 min
const IDLE_MS = 15 * 60_000; // skip sessions active in the last 15 min
const MIN_INTERVAL_MS = 6 * 60 * 60_000; // ≥ 6h between auto-attempts per session
const DELTA = 30; // new unsynced user/assistant messages required to sync

export interface SessionSyncCandidate {
  sessionId: string;
  unsynced: number;
}

/**
 * Run the sandboxed distill for one session and STAGE each change as a
 * reviewable proposal (identical to the manual `/wiki-sync` route). Shared by
 * that route and the auto-sweep. Returns a summary; the session cursor advances
 * only when the user accepts a proposal, never here.
 */
export async function stageSessionSync(
  sessionId: string,
  model?: string,
): Promise<{
  staged: number;
  skipped: number;
  batchId: string | null;
  messageCount: number;
  syncedThroughMessageId: string | null;
}> {
  const db = getDb();
  const { changeset, syncedThroughMessageId, messageCount } = await runSandboxedSync({
    sessionId,
    model,
  });
  if (changeset.length === 0) {
    return { staged: 0, skipped: 0, batchId: null, messageCount, syncedThroughMessageId };
  }

  const sessionTitle =
    (db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
      | { title: string | null }
      | undefined)?.title ?? null;
  const pendingByPath = db.prepare(
    "SELECT 1 FROM wiki_proposals WHERE status = 'pending' AND rel_path = ? LIMIT 1",
  );

  const batchId = nanoid();
  let staged = 0;
  let skipped = 0;
  for (const item of changeset) {
    // Don't stack a second proposal on a page that already has one pending.
    if (pendingByPath.get(item.relPath)) {
      skipped += 1;
      continue;
    }
    await createProposal({
      kind: item.op === 'archive' ? 'archive_page' : 'replace_page',
      title: `Sync: ${sessionTitle ?? 'session'} → ${item.relPath}`,
      relPath: item.relPath,
      payload: {
        markdown: item.after ?? '',
        sessionId,
        syncedThroughMessageId,
        batchId,
      },
    });
    staged += 1;
  }
  return { staged, skipped, batchId, messageCount, syncedThroughMessageId };
}

/**
 * Pick the single most-overdue session to auto-sync, or null. DB-only (pure over
 * the DB) so it's unit-testable; time/in-flight guards come via `exclude`.
 */
export function pickSessionSyncTarget(
  db: Database,
  nowMs: number,
  exclude: Set<string> = new Set(),
): SessionSyncCandidate | null {
  const rows = db
    .prepare(
      `SELECT s.id AS sessionId,
              MAX(m.created_at) AS latest,
              SUM(CASE WHEN m.created_at > COALESCE(cur.created_at, '') THEN 1 ELSE 0 END) AS unsynced
         FROM sessions s
         JOIN projects p ON p.id = s.project_id AND p.hidden = 0 AND p.wiki_auto = 1
         JOIN messages m ON m.session_id = s.id
              AND m.role IN ('user','assistant') AND m.content <> ''
         LEFT JOIN messages cur ON cur.id = s.last_synced_message_id
        WHERE s.bot_kind IS NULL
        GROUP BY s.id`,
    )
    .all() as { sessionId: string; latest: string | null; unsynced: number | null }[];

  // A pending sync proposal for the session means there's unreviewed output —
  // don't re-run the LLM until it's dealt with. (LIKE on the JSON payload; the
  // session id is a nanoid so it can't inject wildcard chars.)
  const pendingSync = db.prepare(
    "SELECT 1 FROM wiki_proposals WHERE status = 'pending' AND payload LIKE ? LIMIT 1",
  );

  let best: SessionSyncCandidate | null = null;
  for (const r of rows) {
    if (exclude.has(r.sessionId)) continue;
    const unsynced = r.unsynced ?? 0;
    if (unsynced < DELTA) continue;
    if (!r.latest) continue;
    const latestMs = new Date(r.latest).getTime();
    if (Number.isNaN(latestMs) || nowMs - latestMs < IDLE_MS) continue; // mid-conversation
    if (pendingSync.get(`%"sessionId":"${r.sessionId}"%`)) continue; // unreviewed sync waiting
    if (!best || unsynced > best.unsynced) best = { sessionId: r.sessionId, unsynced };
  }
  return best;
}

const syncing = new Set<string>();
const lastAttempt = new Map<string, number>();
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (running) return; // single-flight
  if (!getUiConfig().features.wiki) return; // wiki disabled → no auto-sync
  running = true;
  try {
    const db = getDb();
    const now = Date.now();
    const exclude = new Set(syncing);
    for (const [sid, at] of lastAttempt) {
      if (now - at < MIN_INTERVAL_MS) exclude.add(sid);
      else lastAttempt.delete(sid); // stale — let it be reconsidered
    }
    const target = pickSessionSyncTarget(db, now, exclude);
    if (!target) return;
    syncing.add(target.sessionId);
    lastAttempt.set(target.sessionId, now);
    try {
      await stageSessionSync(target.sessionId);
    } finally {
      syncing.delete(target.sessionId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[wiki-session-sync] sweep failed:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

export function startWikiSessionSyncAuto(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWikiSessionSyncAuto(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
  syncing.clear();
  lastAttempt.clear();
}
