const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export interface AgentTerminalGrid {
  cols: number;
  rows: number;
}

export interface AgentTerminalOutputMessage {
  t: 'o';
  d: string;
  replay?: true;
}

function parseBoundedDecimal(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return null;
  }
  return parsed;
}

export function parseAgentTerminalGrid(query: {
  cols?: unknown;
  rows?: unknown;
}): AgentTerminalGrid {
  const cols = parseBoundedDecimal(query.cols, 20, 1000);
  const rows = parseBoundedDecimal(query.rows, 5, 500);
  if (cols === null || rows === null) {
    return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  }
  return { cols, rows };
}

export function createReplayFirstOutput(
  onSend: (message: AgentTerminalOutputMessage) => void,
): {
  onData(data: string): void;
  deliverReplay(snapshot: string): void;
  close(): void;
} {
  const pending: string[] = [];
  let replayDelivered = false;
  let flushing = false;
  let closed = false;

  return {
    onData(data) {
      if (closed) return;
      if (!replayDelivered || flushing) {
        pending.push(data);
        return;
      }
      onSend({ t: 'o', d: data });
    },
    deliverReplay(snapshot) {
      if (closed || replayDelivered) return;
      replayDelivered = true;
      flushing = true;
      onSend({ t: 'o', d: snapshot, replay: true });
      while (pending.length > 0) {
        const data = pending.shift();
        if (data !== undefined) onSend({ t: 'o', d: data });
      }
      flushing = false;
    },
    close() {
      closed = true;
      pending.length = 0;
    },
  };
}
