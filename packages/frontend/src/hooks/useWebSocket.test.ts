import { describe, expect, it, vi } from 'vitest';
import { notifyWebSocketOpen } from './useWebSocket.js';

describe('notifyWebSocketOpen', () => {
  it('hydrates after the first socket open', () => {
    const onOpen = vi.fn();
    const onReconnect = vi.fn();

    notifyWebSocketOpen(false, { onOpen, onReconnect });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('hydrates and signals recovery once for each reconnect open', () => {
    const onOpen = vi.fn();
    const onReconnect = vi.fn();

    notifyWebSocketOpen(true, { onOpen, onReconnect });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
