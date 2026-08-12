import { describe, expect, it } from 'vitest';
import type { Message, MessagePage } from '@pinloom/shared';
import {
  VIRTUAL_INDEX_ORIGIN,
  createChatHistoryState,
  reduceChatHistory,
} from './chat-history.js';

function message(id: string, role: Message['role'] = 'assistant'): Message {
  return {
    id,
    sessionId: 'session-1',
    planItemId: null,
    role,
    content: id,
    toolUse: null,
    pinned: false,
    pinTitle: null,
    pinnedAt: null,
    sourceMessageId: null,
    model: null,
    createdAt: `2026-08-12T00:00:${id.replace(/\D/g, '').padStart(2, '0')}.000Z`,
  };
}

function page(ids: string[], nextCursor: string | null): MessagePage {
  return { items: ids.map((id) => message(id)), nextCursor };
}

describe('chat history reducer', () => {
  it('loads the latest page and prepends older pages without duplicates', () => {
    let state = createChatHistoryState('session-1');
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m3', 'm4'], 'older'),
      requestRevision: 0,
    });
    expect(state.messages.map((item) => item.id)).toEqual(['m3', 'm4']);
    expect(state.firstItemIndex).toBe(VIRTUAL_INDEX_ORIGIN);

    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: page(['m1', 'm2', 'm3'], null),
      requestRevision: 0,
    });
    expect(state.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(state.firstItemIndex).toBe(VIRTUAL_INDEX_ORIGIN - 2);

    const duplicate = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: page(['m1', 'm2'], null),
      requestRevision: 0,
    });
    expect(duplicate.messages).toEqual(state.messages);
    expect(duplicate.firstItemIndex).toBe(state.firstItemIndex);
  });

  it('keeps newer live updates and stream chunks when a page response is stale', () => {
    let state = createChatHistoryState('session-1');
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m1'], null),
      requestRevision: 0,
    });
    const requestRevision = state.liveRevision;
    state = reduceChatHistory(state, {
      type: 'live_update',
      generation: 'session-1',
      message: { ...message('m1'), content: 'pinned live', pinned: true },
    });
    state = reduceChatHistory(state, {
      type: 'live_chunk',
      generation: 'session-1',
      messageId: 'm1',
      chunk: ' chunk',
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: { items: [{ ...message('m1'), content: 'stale snapshot' }], nextCursor: null },
      requestRevision,
    });

    expect(state.messages[0]).toMatchObject({
      content: 'pinned live chunk',
      pinned: true,
    });
    expect(state.liveRevision).toBe(2);
  });

  it('places live messages that arrive during the initial request after its snapshot', () => {
    let state = createChatHistoryState('session-1');
    state = reduceChatHistory(state, {
      type: 'live_append',
      generation: 'session-1',
      message: message('m3'),
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m1', 'm2'], 'older'),
      requestRevision: 0,
    });
    expect(state.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps an unloaded message update newer than an in-flight older page', () => {
    let state = {
      ...createChatHistoryState('session-1'),
      initialized: true,
      nextCursor: 'older',
    };
    const requestRevision = state.liveRevision;
    state = reduceChatHistory(state, {
      type: 'live_update',
      generation: 'session-1',
      message: { ...message('m1'), content: 'new pin state', pinned: true },
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: { items: [{ ...message('m1'), content: 'stale', pinned: false }], nextCursor: null },
      requestRevision,
    });
    expect(state.messages[0]).toMatchObject({ content: 'new pin state', pinned: true });
  });

  it('keeps the oldest loaded cursor when the newest page refreshes', () => {
    let state = createChatHistoryState('session-1');
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m3', 'm4'], 'older-1'),
      requestRevision: 0,
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: page(['m1', 'm2'], 'older-2'),
      requestRevision: 0,
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m4', 'm5'], 'newest-page-cursor'),
      requestRevision: state.liveRevision,
    });

    expect(state.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(state.nextCursor).toBe('older-2');
  });

  it('rebases a disconnected cached window onto the fresh newest page', () => {
    let state = createChatHistoryState('session-1');
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m1', 'm2'], null),
      requestRevision: 0,
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m5', 'm6'], 'before-m5'),
      requestRevision: state.liveRevision,
    });

    expect(state.messages.map((item) => item.id)).toEqual(['m5', 'm6']);
    expect(state.nextCursor).toBe('before-m5');
    expect(state.firstItemIndex).toBe(VIRTUAL_INDEX_ORIGIN);
  });

  it('keeps the latest unloaded live update across repeated stale responses', () => {
    let state = {
      ...createChatHistoryState('session-1'),
      initialized: true,
      nextCursor: 'older',
    };
    state = reduceChatHistory(state, {
      type: 'live_update',
      generation: 'session-1',
      message: { ...message('m1'), content: 'first update' },
    });
    const requestRevision = state.liveRevision;
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: { items: [{ ...message('m1'), content: 'first stale response' }], nextCursor: null },
      requestRevision: 0,
    });
    state = reduceChatHistory(state, {
      type: 'live_update',
      generation: 'session-1',
      message: { ...message('m1'), content: 'second update', pinned: true },
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: { items: [{ ...message('m1'), content: 'second stale response' }], nextCursor: null },
      requestRevision,
    });

    expect(state.messages[0]).toMatchObject({ content: 'second update', pinned: true });
  });

  it('ignores stale session generations', () => {
    const state = reduceChatHistory(createChatHistoryState('session-2'), {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: page(['m1'], null),
      requestRevision: 0,
    });
    expect(state.messages).toEqual([]);
  });

  it('uses render-item deltas when older tools merge into the first tool group', () => {
    let state = createChatHistoryState('session-1');
    const current = { ...message('tool-2', 'tool'), createdAt: '2026-08-12T00:00:02.000Z' };
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'latest',
      page: { items: [current], nextCursor: 'older' },
      requestRevision: 0,
    });
    state = reduceChatHistory(state, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: {
        items: [{ ...message('tool-1', 'tool'), createdAt: '2026-08-12T00:00:01.000Z' }],
        nextCursor: null,
      },
      requestRevision: 0,
    });
    expect(state.firstItemIndex).toBe(VIRTUAL_INDEX_ORIGIN);
    expect(state.messages.map((item) => item.id)).toEqual(['tool-1', 'tool-2']);
  });

  it('reports virtual-index underflow without applying the older page', () => {
    const initial = {
      ...createChatHistoryState('session-1'),
      firstItemIndex: 0,
      messages: [message('m2')],
      initialized: true,
      nextCursor: 'older',
    };
    const state = reduceChatHistory(initial, {
      type: 'page_resolved',
      generation: 'session-1',
      mode: 'older',
      page: page(['m1'], null),
      requestRevision: 0,
    });
    expect(state.messages).toEqual(initial.messages);
    expect(state.pageError).toMatch(/virtual history index/i);
  });

  it('keeps an older cursor retryable after failure and tracks focus transitions', () => {
    let state = {
      ...createChatHistoryState('session-1'),
      nextCursor: 'retry-cursor',
    };
    state = reduceChatHistory(state, {
      type: 'page_failed',
      generation: 'session-1',
      error: 'offline',
      mode: 'older',
    });
    expect(state.nextCursor).toBe('retry-cursor');
    expect(state.pageLoading).toBe(false);
    expect(state.pageError).toBe('offline');
    expect(state.pageErrorMode).toBe('older');

    state = reduceChatHistory(state, {
      type: 'focus_requested',
      generation: 'session-1',
      messageId: 'm0',
    });
    expect(state.focus).toEqual({ messageId: 'm0', status: 'seeking', error: null });
    state = reduceChatHistory(state, {
      type: 'focus_loading',
      generation: 'session-1',
    });
    expect(state.focus.status).toBe('loading');
    state = reduceChatHistory(state, {
      type: 'focus_failed',
      generation: 'session-1',
      error: 'offline',
    });
    expect(state.focus).toEqual({ messageId: 'm0', status: 'error', error: 'offline' });
  });
});
