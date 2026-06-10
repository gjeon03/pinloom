import { describe, it, expect, afterEach } from 'vitest';
import { getAgentAdapter, claudeTransport, claudeTransportIsPty } from './index.js';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';

describe('claudeTransport', () => {
  afterEach(() => {
    delete process.env.PINLOOM_CLAUDE_TRANSPORT;
  });

  it('defaults to sdk and maps pty/terminal, ignoring unknown values', () => {
    expect(claudeTransport()).toBe('sdk');
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'pty';
    expect(claudeTransport()).toBe('pty');
    expect(claudeTransportIsPty()).toBe(true);
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'terminal';
    expect(claudeTransport()).toBe('terminal');
    expect(claudeTransportIsPty()).toBe(false);
    process.env.PINLOOM_CLAUDE_TRANSPORT = 'nonsense';
    expect(claudeTransport()).toBe('sdk');
  });
});

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
