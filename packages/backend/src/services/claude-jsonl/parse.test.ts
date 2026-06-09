import { describe, it, expect } from 'vitest';
import {
  parseJsonlLine,
  parseJsonlLines,
  extractTurnLines,
  toNormalizedEvents,
} from './parse.js';
import type { JsonlLine } from './types.js';

// --- fixture builders (mirror the real transcript schema sampled from
// ~/.claude/projects/<slug>/<sessionId>.jsonl) -----------------------------

function userLine(
  uuid: string,
  parentUuid: string | null,
  content: JsonlLine['message'] extends infer M ? unknown : never,
  extra: Partial<JsonlLine> = {},
): JsonlLine {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: 's1',
    timestamp: '2026-06-10T00:00:00.000Z',
    message: { role: 'user', content: content as never },
    ...extra,
  };
}

function assistantLine(
  uuid: string,
  parentUuid: string | null,
  blocks: unknown[],
  extra: Partial<JsonlLine> = {},
  model = 'claude-opus-4-8',
): JsonlLine {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: 's1',
    requestId: 'req_' + uuid,
    timestamp: '2026-06-10T00:00:01.000Z',
    message: {
      role: 'assistant',
      model,
      content: blocks as never,
      usage: { input_tokens: 5, output_tokens: 10 },
    },
    ...extra,
  };
}

describe('parseJsonlLine', () => {
  it('parses a valid line', () => {
    const line = parseJsonlLine('{"type":"assistant","uuid":"a"}');
    expect(line?.type).toBe('assistant');
    expect(line?.uuid).toBe('a');
  });

  it('returns null for blank, malformed, non-object, and type-less lines', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
    expect(parseJsonlLine('{not json')).toBeNull();
    expect(parseJsonlLine('"a string"')).toBeNull();
    expect(parseJsonlLine('42')).toBeNull();
    expect(parseJsonlLine('{"uuid":"x"}')).toBeNull(); // no type
  });

  it('parseJsonlLines drops unparseable lines but keeps valid ones', () => {
    const blob = [
      '{"type":"user","uuid":"u1"}',
      'garbage{{{',
      '',
      '{"type":"assistant","uuid":"a1"}',
    ].join('\n');
    const lines = parseJsonlLines(blob);
    expect(lines.map((l) => l.uuid)).toEqual(['u1', 'a1']);
  });
});

describe('extractTurnLines', () => {
  it('extracts the descendant subtree rooted at the injected prompt', () => {
    const lines: JsonlLine[] = [
      // pre-turn history; checkpoint is the last of these
      assistantLine('cp', 'older'),
      // injected prompt (parent = checkpoint)
      userLine('u1', 'cp', 'do the thing'),
      assistantLine('a1', 'u1', [{ type: 'text', text: 'on it' }]),
      assistantLine('a2', 'a1', [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ]),
      userLine('ur1', 'a2', [
        { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' },
      ]),
      assistantLine('a3', 'ur1', [{ type: 'text', text: 'done' }]),
    ];
    const turn = extractTurnLines(lines, 'cp');
    expect(turn.map((l) => l.uuid)).toEqual(['a1', 'a2', 'ur1', 'a3']);
  });

  it('excludes a concurrent injection that descends from a different root', () => {
    const lines: JsonlLine[] = [
      assistantLine('cp', 'older'),
      userLine('u1', 'cp', 'mine'),
      // a concurrent prompt injected by someone else — parent is NOT checkpoint
      userLine('uX', 'somethingElse', 'not mine'),
      assistantLine('aX', 'uX', [{ type: 'text', text: 'other turn' }]),
      assistantLine('a1', 'u1', [{ type: 'text', text: 'mine reply' }]),
    ];
    const turn = extractTurnLines(lines, 'cp');
    expect(turn.map((l) => l.uuid)).toEqual(['a1']);
  });

  it('drops noise types, sidechains, and synthetic messages', () => {
    const lines: JsonlLine[] = [
      assistantLine('cp', 'older'),
      userLine('u1', 'cp', 'go'),
      { type: 'file-history-snapshot', uuid: 'noise1', parentUuid: 'u1' },
      { type: 'ai-title', uuid: 'noise2', parentUuid: 'u1' },
      assistantLine('side', 'u1', [{ type: 'text', text: 'subagent' }], {
        isSidechain: true,
      }),
      assistantLine(
        'synth',
        'u1',
        [{ type: 'text', text: 'compaction' }],
        {},
        '<synthetic>',
      ),
      assistantLine('a1', 'u1', [{ type: 'text', text: 'real' }]),
    ];
    const turn = extractTurnLines(lines, 'cp');
    expect(turn.map((l) => l.uuid)).toEqual(['a1']);
  });

  it('handles a fresh session (checkpoint null → first root user line)', () => {
    const lines: JsonlLine[] = [
      userLine('u1', null, 'first message'),
      assistantLine('a1', 'u1', [{ type: 'text', text: 'hi' }]),
    ];
    const turn = extractTurnLines(lines, null);
    expect(turn.map((l) => l.uuid)).toEqual(['a1']);
  });

  it('returns [] when no matching root is found', () => {
    const lines: JsonlLine[] = [assistantLine('a1', 'whatever', [])];
    expect(extractTurnLines(lines, 'cp')).toEqual([]);
  });
});

describe('toNormalizedEvents', () => {
  it('maps a full turn to the normalized event stream in order', () => {
    const turn: JsonlLine[] = [
      assistantLine('a1', 'u1', [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'working' },
      ]),
      assistantLine('a2', 'a1', [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ]),
      userLine('ur1', 'a2', [
        { type: 'tool_result', tool_use_id: 't1', content: 'out.txt' },
      ]),
      assistantLine('a3', 'ur1', [{ type: 'text', text: 'done' }]),
    ];
    const events = toNormalizedEvents(turn, { sessionId: 's1' });
    expect(events).toEqual([
      { type: 'session_id', id: 's1' },
      { type: 'model', model: 'claude-opus-4-8' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'text_delta', text: 'working' },
      { type: 'text_block_end' },
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'ls' },
        summary: 'Bash: ls',
      },
      { type: 'tool_result', text: 'out.txt', stream: 'stdout' },
      { type: 'text_delta', text: 'done' },
      { type: 'text_block_end' },
      { type: 'turn_complete' },
    ]);
  });

  it('emits model only once and marks error tool_results as stderr', () => {
    const turn: JsonlLine[] = [
      assistantLine('a1', 'u1', [{ type: 'text', text: 'a' }]),
      assistantLine('a2', 'a1', [{ type: 'text', text: 'b' }]),
      userLine('ur1', 'a2', [
        { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
      ]),
    ];
    const events = toNormalizedEvents(turn, { sessionId: null });
    const models = events.filter((e) => e.type === 'model');
    expect(models).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'session_id' }),
    );
    expect(events).toContainEqual({
      type: 'tool_result',
      text: 'boom',
      stream: 'stderr',
    });
  });

  it('flattens array-shaped tool_result content', () => {
    const turn: JsonlLine[] = [
      userLine('ur1', 'u1', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'line1' },
            { type: 'text', text: 'line2' },
          ],
        },
      ]),
    ];
    const events = toNormalizedEvents(turn);
    expect(events).toContainEqual({
      type: 'tool_result',
      text: 'line1\nline2',
      stream: 'stdout',
    });
  });
});
