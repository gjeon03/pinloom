import { describe, expect, it } from 'vitest';
import {
  clearBotToken,
  mintBotToken,
  resolveBotSessionByToken,
} from './bot-tokens.js';

describe('bot tokens', () => {
  it('mints a token that resolves back to its session', () => {
    const token = mintBotToken('sess-a');
    expect(resolveBotSessionByToken(token)).toBe('sess-a');
  });

  it('returns null for an unknown token', () => {
    expect(resolveBotSessionByToken('garbage-token-value')).toBeNull();
  });

  it('invalidates the prior token when re-minting for the same session', () => {
    const first = mintBotToken('sess-b');
    const second = mintBotToken('sess-b');
    expect(first).not.toBe(second);
    expect(resolveBotSessionByToken(first)).toBeNull();
    expect(resolveBotSessionByToken(second)).toBe('sess-b');
  });

  it('clears a token', () => {
    const token = mintBotToken('sess-c');
    clearBotToken('sess-c');
    expect(resolveBotSessionByToken(token)).toBeNull();
  });
});
