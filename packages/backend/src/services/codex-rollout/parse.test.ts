import { describe, expect, it } from 'vitest';
import { parseRolloutRows, parseRolloutText, rolloutSessionId } from './parse.js';

// Shapes below are copied from real rollouts on disk, not invented: schema A
// from a 2026-09-04 rollout, schema B from a 2026-09-11 one.

describe('parseRolloutRows — schema A (codex-cli 0.133)', () => {
  it('reads user/assistant text and function_call tools', () => {
    const rows = parseRolloutRows([
      { type: 'event_msg', payload: { type: 'user_message', message: '안녕' } },
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls -la"}' },
      },
      { type: 'event_msg', payload: { type: 'agent_message', message: '결과입니다' } },
    ]);

    expect(rows).toEqual([
      { role: 'user', content: '안녕' },
      {
        role: 'tool',
        content: 'shell: ls -la',
        toolUse: { name: 'shell', input: { cmd: 'ls -la' } },
      },
      { role: 'assistant', content: '결과입니다' },
    ]);
  });
});

describe('parseRolloutRows — schema B (codex-cli 0.154)', () => {
  it('reads item_completed messages whose content is a block array', () => {
    // This is what silently produced zero rows: the tail consumed the file and
    // advanced its cursor, but no branch matched these lines.
    const rows = parseRolloutRows([
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            id: '01a08ddc',
            content: [{ type: 'text', text: '공부 좀 같이 하자.', text_elements: [] }],
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'msg_06e7',
            phase: 'final_answer',
            // Note the capital 'Text' — the tag differs by role, so extraction
            // must key off `text` being a string.
            content: [{ type: 'Text', text: '좋아. 정리해둘게.' }],
          },
        },
      },
    ]);

    expect(rows).toEqual([
      { role: 'user', content: '공부 좀 같이 하자.' },
      { role: 'assistant', content: '좋아. 정리해둘게.' },
    ]);
  });

  it('joins multi-block content and drops Reasoning items', () => {
    const rows = parseRolloutRows([
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            content: [
              { type: 'Text', text: 'first ' },
              { type: 'Text', text: 'second' },
            ],
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'Reasoning', summary_text: ['thinking…'], raw_content: ['…'] },
        },
      },
    ]);

    expect(rows).toEqual([{ role: 'assistant', content: 'first second' }]);
  });

  it('reads custom_tool_call, whose input is a code string rather than JSON args', () => {
    const rows = parseRolloutRows([
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_jsVeo',
          input: 'text( await tools.exec_command({cmd:"pwd"}) )\nmore lines',
        },
      },
      // Outputs stay skipped, same as function_call_output.
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call_jsVeo', output: 'ok' },
      },
    ]);

    expect(rows).toEqual([
      {
        role: 'tool',
        content: 'exec: text( await tools.exec_command({cmd:"pwd"}) )',
        toolUse: {
          name: 'exec',
          input: { input: 'text( await tools.exec_command({cmd:"pwd"}) )\nmore lines' },
        },
      },
    ]);
  });

  it('still skips response_item:message so schema B does not double-count', () => {
    // The same assistant turn also appears as a raw response_item; counting both
    // would duplicate every message.
    const rows = parseRolloutRows([
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'once' }] },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'Text', text: 'once' }] },
      },
    ]);

    expect(rows).toEqual([{ role: 'assistant', content: 'once' }]);
  });

  it('ignores empty or malformed content instead of pushing blank rows', () => {
    expect(
      parseRolloutRows([
        {
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [] } },
        },
        {
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'AgentMessage', content: '   ' } },
        },
        { type: 'event_msg', payload: { type: 'item_completed' } },
      ]),
    ).toEqual([]);
  });
});

describe('rollout plumbing', () => {
  it('parses JSONL defensively and reads the resume token', () => {
    const lines = parseRolloutText(
      [
        '{"type":"session_meta","payload":{"id":"01a08ddc-5096","cwd":"/tmp"}}',
        'not json',
        '{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}',
      ].join('\n'),
    );

    expect(lines).toHaveLength(2); // the bad line is dropped, not thrown
    expect(rolloutSessionId(lines)).toBe('01a08ddc-5096');
  });
});
