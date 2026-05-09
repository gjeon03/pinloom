// Per-team in-memory ring buffer of dispatch events feeding the
// descriptive canvas (PR3). The canvas renders nodes and edges from
// what it observes — it does not author the dispatch graph — so we
// only need a short window of recent events. ~100 per team is plenty
// to backfill a late-joining client.
//
// We deliberately do NOT persist these to SQLite: the underlying
// messages already live in the messages table, and the canvas state
// is purely derived. A backend restart wipes the buffer; the canvas
// just shows "(no recent dispatch activity)" until the next event,
// which is fine for a live observability surface.

import type { TeamDispatchEvent } from '@pinloom/shared';
import { broadcast } from '../ws/hub.js';

const MAX_PER_TEAM = 100;

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
