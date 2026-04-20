import type { WebSocket } from 'ws';
import type { WsEvent } from '@planloom/shared';

const channels = new Map<string, Set<WebSocket>>();

export function subscribe(channel: string, socket: WebSocket) {
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(socket);
}

export function unsubscribe(channel: string, socket: WebSocket) {
  const set = channels.get(channel);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) channels.delete(channel);
}

export function broadcast(channel: string, event: WsEvent) {
  const set = channels.get(channel);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}
