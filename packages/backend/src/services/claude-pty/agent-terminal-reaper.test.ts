import { describe, expect, it } from 'vitest';
import { shouldReapTerminal } from './agent-terminal.js';

const NOW = 1_000_000_000;
const IDLE = 90 * 60_000; // 90 min
const base = { onData: null, turnInFlight: false, lockedBy: null, lastDataAt: NOW - IDLE - 1 };

describe('shouldReapTerminal', () => {
  it('reaps a detached, no-turn, long-idle terminal', () => {
    expect(shouldReapTerminal(base, NOW, IDLE)).toBe(true);
  });

  it('keeps a terminal with an attached client (onData set)', () => {
    expect(shouldReapTerminal({ ...base, onData: () => {} }, NOW, IDLE)).toBe(false);
  });

  it('NEVER reaps a terminal with a turn in flight', () => {
    expect(shouldReapTerminal({ ...base, turnInFlight: true }, NOW, IDLE)).toBe(false);
  });

  it('keeps a terminal whose write lock is held', () => {
    expect(shouldReapTerminal({ ...base, lockedBy: 'human' }, NOW, IDLE)).toBe(false);
  });

  it('keeps a terminal that has not been idle long enough', () => {
    expect(shouldReapTerminal({ ...base, lastDataAt: NOW - 60_000 }, NOW, IDLE)).toBe(false);
  });

  it('reaps exactly at the idle threshold boundary', () => {
    expect(shouldReapTerminal({ ...base, lastDataAt: NOW - IDLE }, NOW, IDLE)).toBe(true);
  });
});
