export interface TerminalViewportSnapshot {
  readonly bufferType: 'normal' | 'alternate';
  readonly viewportY: number;
  readonly baseY: number;
}

export interface TerminalScrollState {
  readonly settled: boolean;
  readonly replaying: boolean;
  readonly following: boolean;
  readonly viewport: TerminalViewportSnapshot | null;
}

export interface TerminalReplayCompletion {
  readonly state: TerminalScrollState;
  readonly scrollToBottom: boolean;
}

export function createTerminalScrollState(): TerminalScrollState {
  return {
    settled: false,
    replaying: true,
    following: true,
    viewport: null,
  };
}

function isViewportSnapshot(value: unknown): value is TerminalViewportSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<TerminalViewportSnapshot>;
  return (
    (snapshot.bufferType === 'normal' || snapshot.bufferType === 'alternate') &&
    Number.isSafeInteger(snapshot.viewportY) &&
    Number.isSafeInteger(snapshot.baseY) &&
    (snapshot.viewportY ?? -1) >= 0 &&
    (snapshot.baseY ?? -1) >= 0
  );
}

export function isTerminalViewportEligible(value: unknown): value is TerminalViewportSnapshot {
  return isViewportSnapshot(value) && value.bufferType === 'normal';
}

export function isTerminalViewportAtBottom(value: unknown): boolean {
  return isTerminalViewportEligible(value) && value.viewportY >= value.baseY;
}

export function beginTerminalReplay(state: TerminalScrollState): TerminalScrollState {
  if (state.settled || state.replaying) return state;
  return { ...state, replaying: true };
}

export function releaseTerminalReplayInput(
  state: TerminalScrollState,
): TerminalScrollState {
  if (!state.replaying) return state;
  return { ...state, replaying: false };
}

export function shouldSuppressTerminalInput(state: TerminalScrollState): boolean {
  return state.replaying;
}

export function completeTerminalReplay(
  state: TerminalScrollState,
): TerminalReplayCompletion {
  if (state.settled) {
    return { state, scrollToBottom: false };
  }
  return {
    state: {
      ...state,
      settled: true,
      replaying: false,
      following: true,
    },
    scrollToBottom: true,
  };
}

export function observeTerminalViewport(
  state: TerminalScrollState,
  viewport: unknown,
): TerminalScrollState {
  if (!isViewportSnapshot(viewport)) {
    return { ...state, viewport: null };
  }
  return {
    ...state,
    following:
      viewport.bufferType === 'normal'
        ? viewport.viewportY >= viewport.baseY
        : state.following,
    viewport: { ...viewport },
  };
}

export function requestTerminalJump(state: TerminalScrollState): TerminalScrollState {
  if (state.following) return state;
  return { ...state, following: true };
}

export function shouldRestoreTerminalBottomAfterFit(state: TerminalScrollState): boolean {
  return state.settled && state.following;
}

export function shouldShowTerminalJump(
  state: TerminalScrollState,
  socketOpen: boolean,
): boolean {
  return (
    socketOpen &&
    state.settled &&
    !state.replaying &&
    isTerminalViewportEligible(state.viewport) &&
    !isTerminalViewportAtBottom(state.viewport)
  );
}
