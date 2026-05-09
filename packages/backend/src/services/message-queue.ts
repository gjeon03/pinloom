// Pending message queue per session. Lives in SQLite so it survives
// backend restarts; the frontend just mirrors it via WS broadcasts.
//
// Drain happens in runner.ts at every agent turn boundary (intra-turn
// natural break + end-of-turn). When this empties out into the agent,
// the helper here is the only place that touches the table.

import { nanoid } from 'nanoid';
import type { QueueItem } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';

interface QueueRow {
  id: string;
  session_id: string;
  content: string;
  model: string | null;
  created_at: string;
}

function rowToItem(row: QueueRow): QueueItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    model: row.model,
    createdAt: row.created_at,
  };
}

// Sessions that currently have at least one queued item — used at backend
// startup to recover stranded queues whose drain trigger (a runner event)
// died with the previous process.
export function listSessionsWithQueuedItems(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT session_id FROM message_queue')
    .all() as Array<{ session_id: string }>;
  return rows.map((r) => r.session_id);
}

export function listQueueItems(sessionId: string): QueueItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM message_queue
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId) as QueueRow[];
  return rows.map(rowToItem);
}

export function broadcastQueueState(sessionId: string): void {
  broadcast(`session:${sessionId}`, {
    type: 'queue_updated',
    sessionId,
    items: listQueueItems(sessionId),
  });
}

interface EnqueueArgs {
  sessionId: string;
  content: string;
  model?: string | null;
}

// Cap a single queued message at ~200KB. The combined drain joins items
// with `\n\n`, so unbounded content here is what the agent sees in a
// single turn; pathological pastes (megabyte logs, etc.) shouldn't be
// silently accepted.
const MAX_QUEUE_CONTENT_BYTES = 200 * 1024;

// Distinct error types so the route layer can map to the right HTTP code.
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = 'SessionNotFoundError';
  }
}

export class InvalidQueueContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueueContentError';
  }
}

export function enqueueMessage(args: EnqueueArgs): QueueItem {
  if (args.content.trim().length === 0) {
    throw new InvalidQueueContentError('content must be non-empty');
  }
  if (Buffer.byteLength(args.content, 'utf8') > MAX_QUEUE_CONTENT_BYTES) {
    throw new InvalidQueueContentError(
      `content exceeds ${MAX_QUEUE_CONTENT_BYTES} bytes`,
    );
  }
  // Verify the session exists up front: an FK violation here would surface
  // as an opaque 500 from Fastify, but the right answer is 404.
  const sessionRow = getDb()
    .prepare('SELECT 1 FROM sessions WHERE id = ?')
    .get(args.sessionId);
  if (!sessionRow) {
    throw new SessionNotFoundError(args.sessionId);
  }
  const id = nanoid();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO message_queue (id, session_id, content, model, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, args.sessionId, args.content, args.model ?? null, now);
  return {
    id,
    sessionId: args.sessionId,
    content: args.content,
    model: args.model ?? null,
    createdAt: now,
  };
}

export function removeQueueItem(sessionId: string, itemId: string): boolean {
  // Scoped by session: prevents a stale or malicious itemId from another
  // session being deleted via this session's endpoint, which would also
  // misroute the resulting `queue_updated` broadcast.
  const result = getDb()
    .prepare('DELETE FROM message_queue WHERE id = ? AND session_id = ?')
    .run(itemId, sessionId);
  return result.changes > 0;
}

export function clearQueue(sessionId: string): void {
  getDb()
    .prepare('DELETE FROM message_queue WHERE session_id = ?')
    .run(sessionId);
}

// Atomically read + delete every queued item for a session. Returns the
// drained items so the caller can hand them off to the agent. The runner
// uses this at every turn boundary; an enqueue may also trigger a drain
// when no run is in flight.
export function drainQueue(sessionId: string): QueueItem[] {
  const db = getDb();
  const tx = db.transaction((sid: string) => {
    const rows = db
      .prepare(
        `SELECT * FROM message_queue
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sid) as QueueRow[];
    if (rows.length > 0) {
      db.prepare('DELETE FROM message_queue WHERE session_id = ?').run(sid);
    }
    return rows;
  });
  return tx(sessionId).map(rowToItem);
}
