import { useEffect, useRef } from 'react';
import type { WsEvent } from '@pinloom/shared';

export function useWebSocket(channel: string | null, onEvent: (ev: WsEvent) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!channel) return;

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?channel=${encodeURIComponent(channel)}`;
    const ws = new WebSocket(url);
    let cancelled = false;

    ws.addEventListener('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as WsEvent;
        if (!cancelled) handlerRef.current(parsed);
      } catch {
        // ignore malformed
      }
    });

    return () => {
      cancelled = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [channel]);
}
