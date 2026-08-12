import { describe, expect, it, vi } from 'vitest';
import {
  createReplayFirstOutput,
  parseAgentTerminalGrid,
} from './agent-terminal-protocol.js';

describe('parseAgentTerminalGrid', () => {
  it.each([
    [{ cols: '20', rows: '5' }, { cols: 20, rows: 5 }],
    [{ cols: '1000', rows: '500' }, { cols: 1000, rows: 500 }],
    [{ cols: '173', rows: '61' }, { cols: 173, rows: 61 }],
  ])('accepts a complete bounded decimal pair', (query, expected) => {
    expect(parseAgentTerminalGrid(query)).toEqual(expected);
  });

  it.each([
    {},
    { cols: '80' },
    { rows: '24' },
    { cols: '20.5', rows: '24' },
    { cols: '0', rows: '24' },
    { cols: '-80', rows: '24' },
    { cols: '1001', rows: '24' },
    { cols: '80', rows: '4' },
    { cols: '80', rows: '501' },
    { cols: ' 80', rows: '24' },
    { cols: '80px', rows: '24' },
    { cols: 80, rows: 24 },
  ])('falls back atomically for invalid query %#', (query) => {
    expect(parseAgentTerminalGrid(query)).toEqual({ cols: 120, rows: 40 });
  });
});

describe('createReplayFirstOutput', () => {
  it('always sends one replay frame, including an empty snapshot', () => {
    const send = vi.fn();
    const output = createReplayFirstOutput(send);

    output.deliverReplay('');
    output.deliverReplay('ignored');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ t: 'o', d: '', replay: true });
  });

  it('flushes boundary output after replay in FIFO order and then sends directly', () => {
    const sent: unknown[] = [];
    const output = createReplayFirstOutput((message) => sent.push(message));

    output.onData('first');
    output.onData('second');
    expect(sent).toEqual([]);

    output.deliverReplay('snapshot');
    output.onData('third');

    expect(sent).toEqual([
      { t: 'o', d: 'snapshot', replay: true },
      { t: 'o', d: 'first' },
      { t: 'o', d: 'second' },
      { t: 'o', d: 'third' },
    ]);
  });

  it('drops buffered and future output after close', () => {
    const send = vi.fn();
    const output = createReplayFirstOutput(send);

    output.onData('buffered');
    output.close();
    output.deliverReplay('snapshot');
    output.onData('future');

    expect(send).not.toHaveBeenCalled();
  });

  it('preserves FIFO order when the sender synchronously produces new output', () => {
    const sent: unknown[] = [];
    let output: ReturnType<typeof createReplayFirstOutput>;
    output = createReplayFirstOutput((message) => {
      sent.push(message);
      if ('replay' in message) output.onData('reentrant');
    });

    output.onData('already-buffered');
    output.deliverReplay('snapshot');

    expect(sent).toEqual([
      { t: 'o', d: 'snapshot', replay: true },
      { t: 'o', d: 'already-buffered' },
      { t: 'o', d: 'reentrant' },
    ]);
  });
});
