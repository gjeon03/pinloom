import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelAiRun,
  clearRun,
  isAiRunning,
  registerRun,
} from './runner.js';

// The activeAbortControllers map is module-private state. Each test must
// clean up its own session ids so leftover entries don't leak across tests.
const tracked = new Set<string>();

function sid(label: string): string {
  const id = `test-${label}-${Math.random().toString(36).slice(2, 8)}`;
  tracked.add(id);
  return id;
}

afterEach(() => {
  for (const id of tracked) cancelAiRun(id);
  tracked.clear();
});

describe('isAiRunning / cancelAiRun (empty state)', () => {
  it('reports no run for an unknown session', () => {
    expect(isAiRunning(sid('a'))).toBe(false);
  });

  it('cancelAiRun returns false when nothing is running', () => {
    expect(cancelAiRun(sid('a'))).toBe(false);
  });
});

describe('registerRun', () => {
  it('returns a fresh, non-aborted AbortController', () => {
    const s = sid('register');
    const ctrl = registerRun(s);
    expect(ctrl.signal.aborted).toBe(false);
    expect(isAiRunning(s)).toBe(true);
  });

  it('aborts the prior controller when called twice for the same session', () => {
    const s = sid('isolate-same');
    const first = registerRun(s);
    const second = registerRun(s);

    // The fix in 347cefb: a second run on the same session must abort the
    // first so the prior SDK loop tears down cleanly.
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(first).not.toBe(second);
    expect(isAiRunning(s)).toBe(true);
  });

  it('does not affect other sessions when registering a new run', () => {
    const sA = sid('iso-a');
    const sB = sid('iso-b');
    const ctrlA = registerRun(sA);
    const ctrlB = registerRun(sB);

    expect(ctrlA.signal.aborted).toBe(false);
    expect(ctrlB.signal.aborted).toBe(false);
    expect(isAiRunning(sA)).toBe(true);
    expect(isAiRunning(sB)).toBe(true);

    // Re-registering on sA must not bleed into sB.
    const ctrlA2 = registerRun(sA);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
    expect(ctrlA2.signal.aborted).toBe(false);
  });
});

describe('cancelAiRun', () => {
  it('aborts the active controller and clears the slot', () => {
    const s = sid('cancel');
    const ctrl = registerRun(s);

    expect(cancelAiRun(s)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(isAiRunning(s)).toBe(false);
  });

  it('only cancels the targeted session', () => {
    const sA = sid('cancel-a');
    const sB = sid('cancel-b');
    const ctrlA = registerRun(sA);
    const ctrlB = registerRun(sB);

    cancelAiRun(sA);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
    expect(isAiRunning(sA)).toBe(false);
    expect(isAiRunning(sB)).toBe(true);
  });

  it('returns false on a second cancel for the same session', () => {
    const s = sid('cancel-twice');
    registerRun(s);
    expect(cancelAiRun(s)).toBe(true);
    expect(cancelAiRun(s)).toBe(false);
  });
});

describe('clearRun race guard', () => {
  it('clears the slot when the passed controller is still active', () => {
    const s = sid('clear-active');
    const ctrl = registerRun(s);

    clearRun(s, ctrl);
    expect(isAiRunning(s)).toBe(false);
  });

  it('is a no-op when a newer controller has replaced the active one', () => {
    // This is the cleanup-vs-restart race the runner has to survive: an old
    // run finishing must not delete the slot a newer run just claimed.
    const s = sid('clear-stale');
    const stale = registerRun(s);
    const fresh = registerRun(s); // aborts `stale`, replaces in map
    expect(stale.signal.aborted).toBe(true);

    clearRun(s, stale); // stale finishing late — should not touch fresh
    expect(isAiRunning(s)).toBe(true);

    clearRun(s, fresh);
    expect(isAiRunning(s)).toBe(false);
  });

  it('is a no-op when the session was never registered', () => {
    const s = sid('clear-empty');
    const phantom = new AbortController();
    expect(() => clearRun(s, phantom)).not.toThrow();
    expect(isAiRunning(s)).toBe(false);
  });
});
