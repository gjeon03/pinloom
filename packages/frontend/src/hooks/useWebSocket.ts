import { useEffect, useRef } from 'react';
import type { WsEvent } from '@pinloom/shared';

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped). Jitter avoids
// thundering-herd if the browser wakes many tabs at once.
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

export function useWebSocket(
  channel: string | null,
  onEvent: (ev: WsEvent) => void,
  options?: { onReconnect?: () => void },
) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const reconnectRef = useRef(options?.onReconnect);
  reconnectRef.current = options?.onReconnect;

  useEffect(() => {
    if (!channel) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everConnected = false;

    function connect() {
      if (cancelled) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?channel=${encodeURIComponent(channel as string)}`;
      ws = new WebSocket(url);

      ws.addEventListener('open', () => {
        if (cancelled) return;
        const wasReconnect = everConnected;
        everConnected = true;
        attempt = 0;
        if (wasReconnect) {
          // Caller can use this to revalidate caches that may have drifted
          // while we were disconnected.
          reconnectRef.current?.();
        }
      });

      ws.addEventListener('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as WsEvent;
          if (!cancelled) handlerRef.current(parsed);
        } catch {
          // ignore malformed
        }
      });

      ws.addEventListener('close', () => {
        if (cancelled) return;
        const delay = backoffMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        // close fires right after, which is where reconnect kicks in.
        // We avoid logging here because the browser already does.
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [channel]);
}
