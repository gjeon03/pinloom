import { describe, it, expect, afterEach } from 'vitest';
import { getAgentAdapter, claudeTransportIsPty } from './index.js';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';

describe('getAgentAdapter', () => {
  afterEach(() => {
    delete process.env.PINLOOM_CLAUDE_TRANSPORT;
  });

  it('routes claude to the SDK adapter by default (no regression)', () => {
    expect(claudeTransportIsPty()).toBe(false);
    expect(getAgentAdapter('claude')).toBe(claudeAdapter);
  });

  it('routes claude to the PTY adapter when PINLOOM_CLAUDE_TRANSPORT=pty', () => {
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'pty';
    expect(claudeTransportIsPty()).toBe(true);
    expect(getAgentAdapter('claude')).toBe(claudePtyAdapter);
  });

  it('routes codex to the codex adapter regardless of the flag', () => {
    expect(getAgentAdapter('codex')).toBe(codexAdapter);
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'pty';
    expect(getAgentAdapter('codex')).toBe(codexAdapter);
  });
});
