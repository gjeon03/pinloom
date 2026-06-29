import { describe, it, expect, afterEach } from 'vitest';
import { getAgentAdapter, claudeTransport, claudeTransportIsPty } from './index.js';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';

describe('claudeTransport', () => {
  afterEach(() => {
    delete process.env.PINLOOM_CLAUDE_TRANSPORT;
  });

  it('defaults to terminal and maps sdk/pty, ignoring unknown values', () => {
    expect(claudeTransport()).toBe('terminal');
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'pty';
    expect(claudeTransport()).toBe('pty');
    expect(claudeTransportIsPty()).toBe(true);
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'sdk';
    expect(claudeTransport()).toBe('sdk');
    expect(claudeTransportIsPty()).toBe(false);
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'nonsense';
    expect(claudeTransport()).toBe('terminal');
  });
});

describe('getAgentAdapter', () => {
  afterEach(() => {
    delete process.env.PINLOOM_CLAUDE_TRANSPORT;
  });

  it('routes claude to the non-pty (SDK) adapter when transport is not pty', () => {
    // Default is 'terminal' (not pty), so getAgentAdapter returns the SDK
    // adapter — terminal rendering is handled outside the adapter layer.
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
