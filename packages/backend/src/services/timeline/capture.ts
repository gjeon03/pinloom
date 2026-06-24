// Work Timeline capture (docs/knowledge-system-v3.md §12, 2C). A background sweep
// — same discipline as message-indexer.ts (interval + single-flight + unref +
// try/catch + NODE_ENV guard) — that distills idle sessions' day activity into
// the per-project timeline entry. Out of the runner's hot path.
//
// Safety properties from the adversarial review:
//  - per-session CURSOR (timeline_capture_state) → idempotent + resumable; the
//    cursor advances ONLY after the entry write succeeds (crash-safe).
//  - keyed (slug:date) MUTEX around read-modify-write of the day file → no
//    blind-overwrite data loss between concurrent captures.
//  - !isAiRunning() re-checked at distill time → never capture a mid-turn session.
//  - per-(project,date) min re-distill interval → bounds LLM cost.
//  - everything is local-tz consistent (the user's "day").

import type { Database } from 'better-sqlite3';
import { getDb } from '../../db/connection.js';
import { isAiRunning } from '../runner.js';
import { listQueueItems } from '../message-queue.js';
import { getProjectWikiSlugByProjectId } from '../wiki-sync.js';
import { distillDay, gitCommitsForDay, type RunDistill } from './distill.js';
import { readEntry, writeEntry } from './store.js';

const IDLE_MS = 15 * 60_000;
const MIN_REDISTILL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
// Skip distilling a session-day whose new-since-cursor content is trivial (e.g.
// a lone "ok") — bounds LLM cost (§12 M1). The cursor isn't advanced, so the day
// is captured later if more substantive content arrives.
const SUBSTANTIVE_MIN_CHARS = 80;

// "busy" = mid-turn OR has a queued-but-not-yet-run message. Either means the
// session's day isn't settled yet, so don't distill it (§12 M2).
function defaultIsBusy(sessionId: string): boolean {
  return isAiRunning(sessionId) || listQueueItems(sessionId).length > 0;
}

/** Local YYYY-MM-DD for an ISO timestamp (the user's "day"). */
export function localDateOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- per-(slug:date) mutex: serialize read-modify-write of a day file ----
const dayLocks = new Map<string, Promise<unknown>>();
function withDayLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = dayLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // keep the chain alive but swallow errors so one failure doesn't poison the lock
  dayLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

// per-(slug:date) last successful distill time → rate-limit. In-memory: a
// restart just means the next sweep may re-distill once (cursor still prevents
// re-embedding unchanged work), which is fine.
const lastRun = new Map<string, number>();

interface CandidateRow {
  session_id: string;
  project_id: string;
  cwd: string;
  project_name: string;
  last_at: string;
  latest_id: string;
}

// Candidate sessions: have substantive (user/assistant, non-empty, non-mirror)
// content, in a visible non-bot project with auto-capture ON.
const CANDIDATE_SQL = `
  SELECT m.session_id AS session_id, s.project_id AS project_id,
         p.cwd AS cwd, p.name AS project_name,
         MAX(m.created_at) AS last_at,
         (SELECT mm.id FROM messages mm
            WHERE mm.session_id = m.session_id AND mm.role IN ('user','assistant')
              AND mm.content <> '' AND mm.source_message_id IS NULL
            ORDER BY mm.created_at DESC LIMIT 1) AS latest_id
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE m.role IN ('user','assistant') AND m.content <> '' AND m.source_message_id IS NULL
    AND s.bot_kind IS NULL AND p.hidden = 0 AND p.timeline_auto = 1
  GROUP BY m.session_id`;

export interface SweepOptions {
  now?: number;
  home?: string;
  runDistill?: RunDistill;
  /** Injectable for tests; defaults to running||queued. */
  isBusy?: (sessionId: string) => boolean;
  idleMs?: number;
  minRedistillMs?: number;
}

interface DaySession {
  sessionId: string;
  /** Latest substantive message id for this session ON this day. */
  dayLatestId: string;
}
interface ProjectDayGroup {
  projectId: string;
  cwd: string;
  projectName: string;
  date: string;
  sessions: DaySession[];
}

/** One sweep: find idle sessions with new work, split each session's new
 *  messages by LOCAL day, group by (project, day), and (rate-limited) distill
 *  each group's entry. Splitting by day (not just the last-activity day) means
 *  cross-midnight work isn't dropped (§12 M1). Returns entries written. */
export async function runCaptureSweep(db: Database, opts: SweepOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? IDLE_MS;
  const minRedistill = opts.minRedistillMs ?? MIN_REDISTILL_MS;
  const isBusy = opts.isBusy ?? defaultIsBusy;

  const rows = db.prepare(CANDIDATE_SQL).all() as CandidateRow[];
  const cursorStmt = db.prepare(
    'SELECT last_captured_message_id AS id FROM timeline_capture_state WHERE session_id = ?',
  );
  const msgTimeStmt = db.prepare('SELECT created_at AS t FROM messages WHERE id = ?');
  const newMsgsStmt = db.prepare(
    `SELECT id, content, created_at FROM messages
     WHERE session_id = ? AND role IN ('user','assistant') AND content <> ''
       AND source_message_id IS NULL AND created_at > ?
     ORDER BY created_at ASC`,
  );

  const groups = new Map<string, ProjectDayGroup>();
  for (const r of rows) {
    if (!r.latest_id) continue;
    if (now - new Date(r.last_at).getTime() < idleMs) continue; // session not idle
    if (isBusy(r.session_id)) continue;
    const cur = cursorStmt.get(r.session_id) as { id: string | null } | undefined;
    if (cur?.id === r.latest_id) continue; // nothing new since last capture
    // created_at of the cursor message (epoch if none / cursor message deleted).
    let since = '';
    if (cur?.id) {
      since = (msgTimeStmt.get(cur.id) as { t: string } | undefined)?.t ?? '';
    }
    const newMsgs = newMsgsStmt.all(r.session_id, since) as {
      id: string;
      content: string;
      created_at: string;
    }[];
    // Split new content by local day → per-day latest id + char delta.
    const perDay = new Map<string, { latestId: string; chars: number }>();
    for (const m of newMsgs) {
      const d = localDateOf(m.created_at);
      const e = perDay.get(d) ?? { latestId: '', chars: 0 };
      e.latestId = m.id; // ASC scan → last wins = latest of that day
      e.chars += (m.content ?? '').length;
      perDay.set(d, e);
    }
    const slug = getProjectWikiSlugByProjectId(r.project_id);
    for (const [date, e] of perDay) {
      if (e.chars < SUBSTANTIVE_MIN_CHARS) continue; // delta floor (§12 M1 cost bound)
      const key = `${slug}:${date}`;
      let g = groups.get(key);
      if (!g) {
        g = { projectId: r.project_id, cwd: r.cwd, projectName: r.project_name, date, sessions: [] };
        groups.set(key, g);
      }
      g.sessions.push({ sessionId: r.session_id, dayLatestId: e.latestId });
    }
  }

  // Process ascending by date so an earlier day commits its cursor before a
  // later one — a later-day failure then can't skip the earlier day.
  const ordered = [...groups.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date));
  let written = 0;
  for (const [key, g] of ordered) {
    if (now - (lastRun.get(key) ?? 0) < minRedistill) continue; // rate limit
    try {
      const ok = await withDayLock(key, () =>
        captureProjectDay(db, g, { now, home: opts.home, runDistill: opts.runDistill, isBusy }),
      );
      if (ok) {
        lastRun.set(key, now);
        written += 1;
      }
    } catch (err) {
      // H1: isolate per group — one project's failure must not starve the rest.
      // eslint-disable-next-line no-console
      console.error(
        `[timeline] capture failed for ${key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return written;
}

// Format a session's messages for ONE local day into a transcript block.
function dayTranscript(db: Database, sessionId: string, date: string): string {
  const rows = db
    .prepare(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = ? AND source_message_id IS NULL
         AND role IN ('user','assistant','tool')
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as { role: string; content: string; created_at: string }[];
  const lines = rows
    .filter((r) => localDateOf(r.created_at) === date && (r.content ?? '').trim() !== '')
    .map((r) => (r.role === 'tool' ? `[tool] ${r.content.trim()}` : `[${r.role}] ${r.content.trim()}`));
  return lines.join('\n\n');
}

async function captureProjectDay(
  db: Database,
  g: ProjectDayGroup,
  opts: { now: number; home?: string; runDistill?: RunDistill; isBusy: (id: string) => boolean },
): Promise<boolean> {
  const slug = getProjectWikiSlugByProjectId(g.projectId);
  // Re-check busy at distill time (select→distill race) and build day blocks.
  const sessions = g.sessions
    .filter((s) => !opts.isBusy(s.sessionId))
    .map((s) => {
      const title = (
        db.prepare('SELECT title FROM sessions WHERE id = ?').get(s.sessionId) as
          | { title: string | null }
          | undefined
      )?.title ?? null;
      return {
        id: s.sessionId,
        title,
        transcript: dayTranscript(db, s.sessionId, g.date),
        dayLatestId: s.dayLatestId,
      };
    })
    .filter((s) => s.transcript.trim() !== '');
  if (sessions.length === 0) return false; // nothing substantive to capture

  const commits = await gitCommitsForDay(g.cwd, g.date);
  const existing = readEntry(slug, g.date, opts.home);
  const md = await distillDay(
    {
      projectName: g.projectName,
      date: g.date,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, transcript: s.transcript })),
      commits,
      existingEntry: existing,
    },
    { runDistill: opts.runDistill },
  );
  if (!md) return false;

  // Write the entry, THEN advance cursors — in that order, so a crash before the
  // write leaves the work to be re-picked-up (cursor unchanged). Each cursor
  // advances to THIS day's latest id (not the session's global latest), so an
  // earlier day captured before a later one stays resumable.
  writeEntry(slug, g.date, md, opts.home);
  const nowIso = new Date(opts.now).toISOString();
  const advance = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO timeline_capture_state (session_id, last_captured_message_id, last_captured_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_captured_message_id = excluded.last_captured_message_id,
         last_captured_at = excluded.last_captured_at`,
    );
    for (const s of sessions) stmt.run(s.id, s.dayLatestId, nowIso);
  });
  advance();
  return true;
}

/**
 * Manual capture ("정리해줘" / the API): distill a project's entry for `date`
 * NOW, ignoring the idle + rate-limit gates (the user asked explicitly). Still
 * uses the keyed mutex and skips mid-turn sessions. Does NOT advance per-session
 * cursors — manual is a one-off, auto-capture continues normally afterward.
 * Returns true if an entry was written.
 */
export async function manualCaptureProjectDay(
  db: Database,
  projectId: string,
  date: string,
  opts: { home?: string; runDistill?: RunDistill; isBusy?: (id: string) => boolean } = {},
): Promise<boolean> {
  const isBusy = opts.isBusy ?? defaultIsBusy;
  const project = db
    .prepare('SELECT name, cwd FROM projects WHERE id = ?')
    .get(projectId) as { name: string; cwd: string } | undefined;
  if (!project) return false;
  const slug = getProjectWikiSlugByProjectId(projectId);
  const sessionRows = db
    .prepare("SELECT id FROM sessions WHERE project_id = ? AND bot_kind IS NULL")
    .all(projectId) as { id: string }[];

  return withDayLock(`${slug}:${date}`, async () => {
    const sessions = sessionRows
      .filter((s) => !isBusy(s.id))
      .map((s) => {
        const title = (
          db.prepare('SELECT title FROM sessions WHERE id = ?').get(s.id) as
            | { title: string | null }
            | undefined
        )?.title ?? null;
        return { id: s.id, title, transcript: dayTranscript(db, s.id, date) };
      })
      .filter((s) => s.transcript.trim() !== '');
    if (sessions.length === 0) return false;
    const commits = await gitCommitsForDay(project.cwd, date);
    const existing = readEntry(slug, date, opts.home);
    const md = await distillDay(
      { projectName: project.name, date, sessions, commits, existingEntry: existing },
      { runDistill: opts.runDistill },
    );
    if (!md) return false;
    writeEntry(slug, date, md, opts.home);
    return true;
  });
}

// ---- background scheduler (mirrors message-indexer.ts) ----
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runCaptureSweep(getDb());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[timeline] capture sweep failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startTimelineCapture(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopTimelineCapture(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

/** Test-only: clear in-memory rate-limit + locks. */
export function __resetTimelineCaptureForTest(): void {
  lastRun.clear();
  dayLocks.clear();
}
