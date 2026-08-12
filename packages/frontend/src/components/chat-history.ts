import type { Message, MessagePage } from '@pinloom/shared';

export const VIRTUAL_INDEX_ORIGIN = 1_000_000_000;

export type ChatRenderItem =
  | { kind: 'message'; message: Message }
  | { kind: 'tool-group'; key: string; messages: Message[] };

export function groupChatMessages(messages: Message[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let tools: Message[] = [];
  const flushTools = () => {
    if (tools.length === 0) return;
    items.push({
      kind: 'tool-group',
      key: `tools-${tools[tools.length - 1].id}`,
      messages: tools,
    });
    tools = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      tools.push(message);
    } else {
      flushTools();
      items.push({ kind: 'message', message });
    }
  }
  flushTools();
  return items;
}

export type ChatFocusStatus = 'idle' | 'seeking' | 'loading' | 'ready' | 'exhausted' | 'error';

export interface ChatHistoryState {
  generation: string;
  messages: Message[];
  initialized: boolean;
  nextCursor: string | null;
  pageLoading: boolean;
  pageError: string | null;
  pageErrorMode: 'latest' | 'older' | null;
  firstItemIndex: number;
  liveRevision: number;
  messageLiveRevisions: Record<string, number>;
  pendingLiveMessages: Record<string, Message>;
  focus: {
    messageId: string | null;
    status: ChatFocusStatus;
    error: string | null;
  };
}

export type ChatHistoryAction =
  | {
      type: 'reset';
      generation: string;
    }
  | {
      type: 'page_loading';
      generation: string;
    }
  | {
      type: 'page_resolved';
      generation: string;
      mode: 'latest' | 'older';
      page: MessagePage;
      requestRevision: number;
    }
  | {
      type: 'page_failed';
      generation: string;
      error: string;
      mode: 'latest' | 'older';
    }
  | {
      type: 'live_append' | 'live_update';
      generation: string;
      message: Message;
    }
  | {
      type: 'live_chunk';
      generation: string;
      messageId: string;
      chunk: string;
    }
  | {
      type: 'focus_requested';
      generation: string;
      messageId: string;
    }
  | {
      type: 'focus_loading';
      generation: string;
    }
  | {
      type: 'focus_ready' | 'focus_exhausted';
      generation: string;
    }
  | {
      type: 'focus_failed';
      generation: string;
      error: string;
    }
  | {
      type: 'focus_cleared';
      generation: string;
    };

export function createChatHistoryState(generation: string): ChatHistoryState {
  return {
    generation,
    messages: [],
    initialized: false,
    nextCursor: null,
    pageLoading: false,
    pageError: null,
    pageErrorMode: null,
    firstItemIndex: VIRTUAL_INDEX_ORIGIN,
    liveRevision: 0,
    messageLiveRevisions: {},
    pendingLiveMessages: {},
    focus: { messageId: null, status: 'idle', error: null },
  };
}

function mergePageMessages(
  state: ChatHistoryState,
  items: Message[],
  requestRevision: number,
  mode: 'latest' | 'older',
): Message[] {
  const resolved = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of items) {
    const liveRevision = state.messageLiveRevisions[message.id] ?? 0;
    if (liveRevision > requestRevision) {
      const pending = state.pendingLiveMessages[message.id];
      if (pending) resolved.set(message.id, pending);
      continue;
    }
    resolved.set(message.id, message);
  }
  const currentIds = state.messages.map((message) => message.id);
  const pageIds = items.map((message) => message.id);
  const orderedIds = mode === 'older'
    ? [...pageIds, ...currentIds]
    : state.initialized
      ? [...currentIds, ...pageIds]
      : [...pageIds, ...currentIds];
  const seen = new Set<string>();
  const messages: Message[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    const message = resolved.get(id);
    if (!message) continue;
    seen.add(id);
    messages.push(message);
  }
  return messages;
}

function shouldRebaseLatestPage(state: ChatHistoryState, items: Message[]): boolean {
  if (!state.initialized) return false;
  const currentIds = new Set(state.messages.map((message) => message.id));
  return items.length === 0 || !items.some((message) => currentIds.has(message.id));
}

function rebaseLatestPage(
  state: ChatHistoryState,
  items: Message[],
  requestRevision: number,
): Message[] {
  const current = new Map(state.messages.map((message) => [message.id, message]));
  const pageIds = new Set(items.map((message) => message.id));
  const pageMessages = items.map((message) => {
    const liveRevision = state.messageLiveRevisions[message.id] ?? 0;
    return liveRevision > requestRevision ? current.get(message.id) ?? message : message;
  });
  const liveAfterRequest = state.messages.filter((message) =>
    !pageIds.has(message.id) &&
    (state.messageLiveRevisions[message.id] ?? 0) > requestRevision,
  );
  return [...pageMessages, ...liveAfterRequest];
}

function withLiveMessage(
  state: ChatHistoryState,
  message: Message,
  appendOnly: boolean,
): ChatHistoryState {
  const revision = state.liveRevision + 1;
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (appendOnly && index >= 0) return state;
  if (!appendOnly && index < 0) {
    return {
      ...state,
      liveRevision: revision,
      messageLiveRevisions: {
        ...state.messageLiveRevisions,
        [message.id]: revision,
      },
      pendingLiveMessages: {
        ...state.pendingLiveMessages,
        [message.id]: message,
      },
    };
  }
  const messages = index < 0
    ? [...state.messages, message]
    : appendOnly
      ? state.messages
      : state.messages.map((item) => (item.id === message.id ? message : item));
  return {
    ...state,
    messages,
    liveRevision: revision,
    messageLiveRevisions: {
      ...state.messageLiveRevisions,
      [message.id]: revision,
    },
  };
}

function pruneMaterializedPendingMessages(
  pending: Record<string, Message>,
  messages: Message[],
): Record<string, Message> {
  const materializedIds = new Set(messages.map((message) => message.id));
  const remaining = Object.entries(pending)
    .filter(([id]) => !materializedIds.has(id));
  if (remaining.length === Object.keys(pending).length) return pending;
  return Object.fromEntries(remaining);
}

export function reduceChatHistory(
  state: ChatHistoryState,
  action: ChatHistoryAction,
): ChatHistoryState {
  if (action.type === 'reset') return createChatHistoryState(action.generation);
  if (action.generation !== state.generation) return state;

  switch (action.type) {
    case 'page_loading':
      return { ...state, pageLoading: true, pageError: null, pageErrorMode: null };
    case 'page_failed':
      return {
        ...state,
        pageLoading: false,
        pageError: action.error,
        pageErrorMode: action.mode,
      };
    case 'page_resolved': {
      const rebaseLatest = action.mode === 'latest' &&
        shouldRebaseLatestPage(state, action.page.items);
      const messages = rebaseLatest
        ? rebaseLatestPage(state, action.page.items, action.requestRevision)
        : mergePageMessages(
          state,
          action.page.items,
          action.requestRevision,
          action.mode,
        );
      if (action.mode === 'older') {
        const renderDelta = groupChatMessages(messages).length -
          groupChatMessages(state.messages).length;
        if (renderDelta >= state.firstItemIndex) {
          return {
            ...state,
            pageLoading: false,
            pageError: 'Virtual history index exhausted. Refresh to recover.',
            pageErrorMode: 'older',
          };
        }
        return {
          ...state,
          messages,
          initialized: true,
          nextCursor: action.page.nextCursor,
          pageLoading: false,
          pageError: null,
          pageErrorMode: null,
          firstItemIndex: state.firstItemIndex - renderDelta,
          pendingLiveMessages: pruneMaterializedPendingMessages(
            state.pendingLiveMessages,
            messages,
          ),
        };
      }
      return {
        ...state,
        messages,
        initialized: true,
        nextCursor: rebaseLatest || !state.initialized
          ? action.page.nextCursor
          : state.nextCursor,
        pageLoading: false,
        pageError: null,
        pageErrorMode: null,
        firstItemIndex: rebaseLatest ? VIRTUAL_INDEX_ORIGIN : state.firstItemIndex,
        pendingLiveMessages: pruneMaterializedPendingMessages(
          state.pendingLiveMessages,
          messages,
        ),
      };
    }
    case 'live_append':
      return withLiveMessage(state, action.message, true);
    case 'live_update':
      return withLiveMessage(state, action.message, false);
    case 'live_chunk': {
      const existing = state.messages.find((message) => message.id === action.messageId);
      if (!existing) return state;
      return withLiveMessage(
        state,
        { ...existing, content: existing.content + action.chunk },
        false,
      );
    }
    case 'focus_requested':
      return {
        ...state,
        focus: { messageId: action.messageId, status: 'seeking', error: null },
      };
    case 'focus_loading':
      return {
        ...state,
        focus: { ...state.focus, status: 'loading', error: null },
      };
    case 'focus_ready':
      return {
        ...state,
        focus: { ...state.focus, status: 'ready', error: null },
      };
    case 'focus_exhausted':
      return {
        ...state,
        focus: { ...state.focus, status: 'exhausted', error: null },
      };
    case 'focus_failed':
      return {
        ...state,
        focus: { ...state.focus, status: 'error', error: action.error },
      };
    case 'focus_cleared':
      return {
        ...state,
        focus: { messageId: null, status: 'idle', error: null },
      };
  }
}
