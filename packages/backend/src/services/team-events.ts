// Per-team in-memory ring buffer of dispatch events feeding the
// descriptive canvas (PR3). The canvas renders nodes and edges from
// what it observes — it does not author the dispatch graph — so we
// only need a short window of recent events.
//
// We deliberately do NOT persist these to SQLite: the underlying
// messages already live in the messages table, and the canvas state
// is purely derived. A backend restart wipes the buffer; the canvas
// just shows "(no recent dispatch activity)" until the next event,
// which is fine for a live observability surface.

import type { TeamDispatchEvent } from '@pinloom/shared';
import { broadcast } from '../ws/hub.js';

// Sized for broadcast fanout: a single `team_send_tag` to N workers
// emits N `dispatch_send` events synchronously, then each worker emits
// its own `worker_status` events as it picks up work. With realistic
// upper bounds (≤20 workers per team, ~16 tags per worker), a single
// broadcast plus its follow-up status churn can produce ~40-60 events;
// 500 lets a late-joining canvas client backfill multiple broadcasts
// without history loss while staying trivially cheap in memory.
const MAX_PER_TEAM = 500;

const buffersByTeamId = new Map<string, TeamDispatchEvent[]>();

export function emitDispatchEvent(event: TeamDispatchEvent): void {
  let buf = buffersByTeamId.get(event.teamId);
  if (!buf) {
    buf = [];
    buffersByTeamId.set(event.teamId, buf);
  }
  buf.push(event);
  if (buf.length > MAX_PER_TEAM) buf.splice(0, buf.length - MAX_PER_TEAM);

  broadcast(`team:${event.teamId}`, {
    type: 'team_dispatch_event',
    event,
  });
}

export function listRecentEvents(
  teamId: string,
  limit = MAX_PER_TEAM,
): TeamDispatchEvent[] {
  const buf = buffersByTeamId.get(teamId);
  if (!buf) return [];
  if (buf.length <= limit) return [...buf];
  return buf.slice(buf.length - limit);
}

export function clearTeamEvents(teamId: string): void {
  buffersByTeamId.delete(teamId);
}
