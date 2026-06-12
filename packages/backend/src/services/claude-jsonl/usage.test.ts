import { describe, it, expect } from 'vitest';
import { aggregateUsage } from './usage.js';
import type { JsonlLine } from './types.js';

function asst(
  model: string,
  usage: JsonlLine['message'] extends infer M ? Record<string, number> : never,
  extra: Partial<JsonlLine> = {},
): JsonlLine {
  return {
    type: 'assistant',
    uuid: 'u',
    sessionId: 's1',
    timestamp: '2026-06-10T12:00:00.000Z',
    message: { role: 'assistant', model, usage: usage as never },
    ...extra,
  };
}

describe('aggregateUsage', () => {
  it('sums tokens across billed assistant messages', () => {
    const lines: JsonlLine[] = [
      asst('claude-opus-4-8', {
        input_tokens: 10,
        output_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
      }),
      asst('claude-opus-4-8', {
        input_tokens: 5,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 30,
      }),
    ];
    const { total } = aggregateUsage(lines);
    expect(total).toEqual({
      inputTokens: 15,
      outputTokens: 120,
      cacheCreationTokens: 50,
      cacheReadTokens: 230,
      messages: 2,
    });
  });

  it('groups by model and by UTC day', () => {
    const lines: JsonlLine[] = [
      asst(
        'claude-opus-4-8',
        { output_tokens: 100 },
        { timestamp: '2026-06-10T01:00:00Z' },
      ),
      asst(
        'claude-sonnet-4-6',
        { output_tokens: 40 },
        { timestamp: '2026-06-11T01:00:00Z' },
      ),
    ];
    const { byModel, byDay } = aggregateUsage(lines);
    expect(byModel['claude-opus-4-8'].outputTokens).toBe(100);
    expect(byModel['claude-sonnet-4-6'].outputTokens).toBe(40);
    expect(byDay['2026-06-10'].outputTokens).toBe(100);
    expect(byDay['2026-06-11'].outputTokens).toBe(40);
  });

  it('skips synthetic, sidechain, non-assistant, and usage-less lines', () => {
    const lines: JsonlLine[] = [
      asst('<synthetic>', { output_tokens: 999 }),
      asst('claude-opus-4-8', { output_tokens: 999 }, { isSidechain: true }),
      { type: 'user', uuid: 'x', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'y', message: { role: 'assistant', model: 'claude-opus-4-8' } },
      asst('claude-opus-4-8', { output_tokens: 7 }),
    ];
    const { total } = aggregateUsage(lines);
    expect(total.outputTokens).toBe(7);
    expect(total.messages).toBe(1);
  });
});
