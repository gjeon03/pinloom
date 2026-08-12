import { describe, expect, it } from 'vitest';
import {
  beginTerminalReplay,
  completeTerminalReplay,
  createTerminalScrollState,
  isTerminalViewportAtBottom,
  isTerminalViewportEligible,
  observeTerminalViewport,
  releaseTerminalReplayInput,
  requestTerminalJump,
  shouldRestoreTerminalBottomAfterFit,
  shouldShowTerminalJump,
  shouldSuppressTerminalInput,
  type TerminalViewportSnapshot,
} from './agent-terminal-scroll.js';

const normalBottom: TerminalViewportSnapshot = {
  bufferType: 'normal',
  viewportY: 12,
  baseY: 12,
};

const normalAbove: TerminalViewportSnapshot = {
  bufferType: 'normal',
  viewportY: 4,
  baseY: 12,
};

describe('terminal viewport eligibility', () => {
  it('uses viewportY >= baseY as the normal-buffer bottom boundary', () => {
    expect(isTerminalViewportAtBottom({ ...normalBottom, viewportY: 11 })).toBe(false);
    expect(isTerminalViewportAtBottom(normalBottom)).toBe(true);
    expect(isTerminalViewportAtBottom({ ...normalBottom, viewportY: 13 })).toBe(true);
  });

  it('rejects alternate and malformed snapshots', () => {
    expect(
      isTerminalViewportEligible({
        bufferType: 'alternate',
        viewportY: 0,
        baseY: 0,
      }),
    ).toBe(false);
    expect(isTerminalViewportEligible(null)).toBe(false);
    expect(
      isTerminalViewportEligible({
        bufferType: 'normal',
        viewportY: Number.NaN,
        baseY: 1,
      }),
    ).toBe(false);
    expect(
      isTerminalViewportEligible({
        bufferType: 'normal',
        viewportY: -1,
        baseY: 1,
      }),
    ).toBe(false);
    expect(
      isTerminalViewportEligible({
        bufferType: 'normal',
        viewportY: Number.MAX_SAFE_INTEGER + 1,
        baseY: 1,
      }),
    ).toBe(false);
  });
});

describe('terminal scroll controller', () => {
  it('starts unsettled and hides the jump action until replay settles', () => {
    const initial = observeTerminalViewport(createTerminalScrollState(), normalAbove);

    expect(initial.settled).toBe(false);
    expect(initial.replaying).toBe(true);
    expect(shouldSuppressTerminalInput(initial)).toBe(true);
    expect(shouldShowTerminalJump(initial, true)).toBe(false);
  });

  it('tracks user scroll-up, natural bottom return, and explicit jump immutably', () => {
    const settled = completeTerminalReplay(createTerminalScrollState()).state;
    const scrolled = observeTerminalViewport(settled, normalAbove);
    const returned = observeTerminalViewport(scrolled, normalBottom);
    const jumped = requestTerminalJump(scrolled);

    expect(scrolled).not.toBe(settled);
    expect(scrolled.following).toBe(false);
    expect(shouldShowTerminalJump(scrolled, true)).toBe(true);
    expect(returned.following).toBe(true);
    expect(shouldShowTerminalJump(returned, true)).toBe(false);
    expect(jumped.following).toBe(true);
    expect(scrolled.following).toBe(false);
  });

  it('never exposes the action for a closed socket or alternate buffer', () => {
    const settled = completeTerminalReplay(createTerminalScrollState()).state;
    const above = observeTerminalViewport(settled, normalAbove);
    const alternate = observeTerminalViewport(above, {
      bufferType: 'alternate',
      viewportY: 0,
      baseY: 0,
    });

    expect(shouldShowTerminalJump(above, false)).toBe(false);
    expect(shouldShowTerminalJump(alternate, true)).toBe(false);
  });

  it('preserves bottom across fits only after settlement while following', () => {
    const initial = createTerminalScrollState();
    const settled = completeTerminalReplay(initial).state;
    const scrolled = observeTerminalViewport(settled, normalAbove);

    expect(shouldRestoreTerminalBottomAfterFit(initial)).toBe(false);
    expect(shouldRestoreTerminalBottomAfterFit(settled)).toBe(true);
    expect(shouldRestoreTerminalBottomAfterFit(scrolled)).toBe(false);
  });

  it('lets timeout release input without settling and lets the callback settle once', () => {
    const initial = createTerminalScrollState();
    const replaying = beginTerminalReplay(initial);
    const timedOut = releaseTerminalReplayInput(replaying);
    const firstCallback = completeTerminalReplay(timedOut);
    const secondCallback = completeTerminalReplay(firstCallback.state);

    expect(replaying.replaying).toBe(true);
    expect(replaying).toBe(initial);
    expect(shouldSuppressTerminalInput(replaying)).toBe(true);
    expect(timedOut.replaying).toBe(false);
    expect(shouldSuppressTerminalInput(timedOut)).toBe(false);
    expect(timedOut.settled).toBe(false);
    expect(shouldShowTerminalJump(timedOut, true)).toBe(false);
    expect(firstCallback.scrollToBottom).toBe(true);
    expect(firstCallback.state).toMatchObject({
      settled: true,
      replaying: false,
      following: true,
    });
    expect(secondCallback.scrollToBottom).toBe(false);
    expect(secondCallback.state).toBe(firstCallback.state);
  });

  it('discards malformed observations instead of retaining stale eligibility', () => {
    const settled = completeTerminalReplay(createTerminalScrollState()).state;
    const visible = observeTerminalViewport(settled, normalAbove);
    const malformed = observeTerminalViewport(visible, {
      bufferType: 'normal',
      viewportY: Number.POSITIVE_INFINITY,
      baseY: 12,
    });

    expect(shouldShowTerminalJump(visible, true)).toBe(true);
    expect(malformed.viewport).toBeNull();
    expect(shouldShowTerminalJump(malformed, true)).toBe(false);
  });
});
