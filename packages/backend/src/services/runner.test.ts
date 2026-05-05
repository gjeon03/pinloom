import { describe, it, expect } from 'vitest';
import {
  buildFallbackPrompt,
  buildPlanContext,
  extractMentions,
  summarizeToolCall,
  toolResultText,
} from './runner.js';

describe('summarizeToolCall', () => {
  it('returns the tool name when there is no input', () => {
    expect(summarizeToolCall({ name: 'Read' })).toBe('Read');
  });

  it('falls back to "tool" when the name is missing', () => {
    expect(summarizeToolCall({})).toBe('tool');
  });

  it('shows the command for Bash-like tools', () => {
    expect(summarizeToolCall({ name: 'Bash', input: { command: 'ls -la' } })).toBe(
      'Bash: ls -la',
    );
  });

  it('shows file_path with no suffix for plain reads', () => {
    expect(summarizeToolCall({ name: 'Read', input: { file_path: '/a/b.ts' } })).toBe(
      'Read: /a/b.ts',
    );
  });

  it('marks file_path as (edit) when old_string is present', () => {
    expect(
      summarizeToolCall({
        name: 'Edit',
        input: { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' },
      }),
    ).toBe('Edit: /a.ts (edit)');
  });

  it('marks file_path as (write) when content is present', () => {
    expect(
      summarizeToolCall({
        name: 'Write',
        input: { file_path: '/a.ts', content: 'hello' },
      }),
    ).toBe('Write: /a.ts (write)');
  });

  it('shows pattern for grep-like tools', () => {
    expect(summarizeToolCall({ name: 'Grep', input: { pattern: 'foo.*bar' } })).toBe(
      'Grep: foo.*bar',
    );
  });

  it('returns just the name when input is present but unrecognized', () => {
    expect(summarizeToolCall({ name: 'Custom', input: { weird: 'shape' } })).toBe('Custom');
  });
});

describe('toolResultText', () => {
  it('returns the string when content is a plain string', () => {
    expect(toolResultText('hello')).toBe('hello');
  });

  it('joins string array elements with newlines', () => {
    expect(toolResultText(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('extracts text from {text} blocks', () => {
    expect(
      toolResultText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
    ).toBe('one\ntwo');
  });

  it('mixes raw strings and {text} blocks', () => {
    expect(toolResultText(['raw', { type: 'text', text: 'block' }])).toBe('raw\nblock');
  });

  it('drops blocks without a string text field', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'kept' },
        { type: 'text', text: 123 as unknown as string },
        { type: 'image' },
      ]),
    ).toBe('kept');
  });

  it('returns empty string for unsupported shapes', () => {
    expect(toolResultText(null)).toBe('');
    expect(toolResultText(42)).toBe('');
    expect(toolResultText({ not: 'an array' })).toBe('');
  });
});

describe('extractMentions', () => {
  it('returns an empty array when there are no @mentions', () => {
    expect(extractMentions('plain text without mentions')).toEqual([]);
  });

  it('extracts a single id of at least 10 chars', () => {
    expect(extractMentions('see @abc1234567 for details')).toEqual(['abc1234567']);
  });

  it('extracts multiple ids in order', () => {
    expect(
      extractMentions('first @aaaaaaaaaa then @bbbbbbbbbb_ then @ccc-ccc-ccc'),
    ).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb_', 'ccc-ccc-ccc']);
  });

  it('ignores tokens shorter than 10 characters', () => {
    expect(extractMentions('not @short here')).toEqual([]);
  });

  it('only matches the safe id charset (alphanumeric, underscore, dash)', () => {
    // The space breaks the match after "valid12345"
    expect(extractMentions('@valid12345 plus @invalid!chars')).toEqual([
      'valid12345',
      'invalid',
    ].filter((s) => s.length >= 10));
  });
});

describe('buildPlanContext', () => {
  it('returns an empty string when there are no plan items', () => {
    expect(buildPlanContext([])).toBe('');
  });

  it('formats items as a status-prefixed list and includes the @<id> hint', () => {
    const out = buildPlanContext([
      { id: 'id-1', title: 'First task', status: 'todo' },
      { id: 'id-2', title: 'Second task', status: 'done' },
    ]);
    expect(out).toContain('## Current plan items');
    expect(out).toContain('- [todo] (id-1) First task');
    expect(out).toContain('- [done] (id-2) Second task');
    expect(out).toContain('Reference by @<id>');
  });
});

describe('buildFallbackPrompt', () => {
  it('returns the current message verbatim when history is empty', () => {
    expect(buildFallbackPrompt([], 'hello')).toBe('hello');
  });

  it('renders prior messages with role labels and appends the new turn', () => {
    const out = buildFallbackPrompt(
      [
        { role: 'user', content: 'first', created_at: '2020-01-01T00:00:00Z' },
        { role: 'assistant', content: 'reply', created_at: '2020-01-01T00:01:00Z' },
      ],
      'next question',
    );
    expect(out).toContain('## Prior conversation (reconstructed from local history)');
    expect(out).toContain('**Human**: first');
    expect(out).toContain('**You (AI)**: reply');
    expect(out).toContain('## New message');
    expect(out).toContain('**Human**: next question');
    expect(out).toContain('Continue the conversation.');
  });

  it('preserves history order', () => {
    const out = buildFallbackPrompt(
      [
        { role: 'user', content: 'A', created_at: '2020-01-01T00:00:00Z' },
        { role: 'assistant', content: 'B', created_at: '2020-01-01T00:01:00Z' },
        { role: 'user', content: 'C', created_at: '2020-01-01T00:02:00Z' },
      ],
      'D',
    );
    const idxA = out.indexOf('**Human**: A');
    const idxB = out.indexOf('**You (AI)**: B');
    const idxC = out.indexOf('**Human**: C');
    const idxD = out.indexOf('**Human**: D');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxD);
  });
});
