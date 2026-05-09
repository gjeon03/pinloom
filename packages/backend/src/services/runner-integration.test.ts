import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WebSocket } from 'ws';
import type { WsEvent } from '@pinloom/shared';

// vi.mock is hoisted above imports so runner.ts picks up the mock when it
// loads `query` from the SDK module.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';
import { cancelAiRun, sendUserMessage } from './runner.js';
import { subscribe, unsubscribe } from '../ws/hub.js';

const mockQuery = vi.mocked(query);

type QueryArgs = Parameters<typeof query>[0];
type QueryReturn = ReturnType<typeof query>;
type QueryImpl = (args: QueryArgs) => QueryReturn;

function setQueryImpl(impl: QueryImpl) {
  mockQuery.mockImplementation(impl as unknown as typeof query);
}

function emptyStream(): QueryReturn {
  return (async function* () {})() as unknown as QueryReturn;
}

function errorStream(err: Error): QueryReturn {
  return (async function* () {
    throw err;
  })() as unknown as QueryReturn;
}

function streamFromMessages(messages: unknown[]): QueryReturn {
  return (async function* () {
    for (const m of messages) yield m;
  })() as unknown as QueryReturn;
}

// SDK message shape helpers — keep tests readable by hiding the nested
// stream_event envelope structure runner.ts expects.
const sdk = {
  textDelta(text: string) {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    };
  },
  thinkingStart() {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      },
    };
  },
  thinkingDelta(thinking: string) {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking },
      },
    };
  },
  toolUseBlockStart() {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use' },
      },
    };
  },
  messageStop() {
    return {
      type: 'stream_event',
      event: { type: 'message_stop' },
    };
  },
  assistant({
    sessionId,
    model,
    blocks,
  }: {
    sessionId?: string;
    model?: string;
    blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    >;
  }) {
    return {
      type: 'assistant',
      session_id: sessionId,
      message: { id: 'msg-x', model, content: blocks },
    };
  },
  toolResult(content: string, isError = false) {
    return {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content, is_error: isError }],
      },
    };
  },
  result({ text, sessionId }: { text: string; sessionId?: string }) {
    return {
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: sessionId,
    };
  },
};

// Mock that consumes the runner's prompt AsyncIterable just like the real SDK
// does. Lets us assert that mid-run pushMessage queues into the same query()
// invocation instead of starting a fresh one.
function streamConsumingPrompts(
  handler: (prompt: unknown, idx: number) => unknown[],
): QueryImpl {
  return (args: QueryArgs) => {
    const promptIter = args.prompt as AsyncIterable<unknown>;
    return (async function* () {
      let idx = 0;
      for await (const p of promptIter) {
        const messages = handler(p, idx);
        idx++;
        for (const m of messages) yield m;
      }
    })() as unknown as QueryReturn;
  };
}

function abortAwaitingStream(args: QueryArgs): QueryReturn {
  // Hangs forever until the abortController fires, then rejects so the runner
  // exits its for-await loop. Models the SDK's expected abort semantics.
  const ac = (args.options as { abortController?: AbortController }).abortController;
  return (async function* () {
    await new Promise<void>((_resolve, reject) => {
      if (!ac) return;
      if (ac.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      ac.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  })() as unknown as QueryReturn;
}

function seedProject(id: string, cwd = '/tmp/test-project') {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, 'Test', cwd, now, now);
}

function seedPlan(id: string, projectId: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO plans (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, 'Plan', 'draft', now, now);
}

function seedPlanItem(id: string, planId: string, title = 'Task') {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO plan_items (id, plan_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, planId, title, now, now);
}

function seedSession(id: string, projectId: string, planId: string | null = null) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'INSERT INTO sessions (id, project_id, plan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, projectId, planId, now, now);
}

interface CapturedEvents {
  events: WsEvent[];
  stop: () => void;
}

function captureEvents(channel: string): CapturedEvents {
  const events: WsEvent[] = [];
  const fakeSocket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      events.push(JSON.parse(data) as WsEvent);
    },
  };
  subscribe(channel, fakeSocket as unknown as WebSocket);
  return {
    events,
    stop: () => unsubscribe(channel, fakeSocket as unknown as WebSocket),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function isFinishedOrError(events: WsEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === 'run_status' &&
      (e.status === 'finished' || e.status === 'error'),
  );
}

beforeAll(() => {
  // Force migrations to run on the temp DB path set by test-setup.ts.
  getDb();
});

beforeEach(() => {
  mockQuery.mockReset();
  const db = getDb();
  // Order matters because of FKs.
  db.exec(`
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM plan_items;
    DELETE FROM plans;
    DELETE FROM projects;
  `);
});

afterEach(() => {
  // The activeRuns map is module-private state and persists across tests.
  // Cancel any leftover run so the next test starts with a clean slate
  // (otherwise a queued mid-run mock would receive the next test's prompts).
  cancelAiRun('s1');
});

describe('sendUserMessage — user message persistence', () => {
  it('persists the user message synchronously and returns it', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'hello world');

    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello world');
    expect(msg.sessionId).toBe('s1');
    expect(msg.planItemId).toBeNull();
    expect(msg.id).toBeTruthy();

    const row = getDb()
      .prepare(
        'SELECT id, role, content FROM messages WHERE session_id = ? AND role = ?',
      )
      .get('s1', 'user') as { id: string; role: string; content: string };
    expect(row.id).toBe(msg.id);
    expect(row.content).toBe('hello world');

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('throws when the session does not exist', async () => {
    await expect(sendUserMessage('nope', 'hi')).rejects.toThrow(/not found/);
  });

  it('passes the project cwd to the SDK as the working directory', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1', '/some/project/path');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const args = mockQuery.mock.calls[0][0] as QueryArgs;
    expect((args.options as { cwd?: string }).cwd).toBe('/some/project/path');
  });
});

describe('sendUserMessage — plan-item resolution', () => {
  it('binds the user message to a planItemId resolved from @<id>', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemxxxxxx', 'pl1', 'Wire up auth');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'work on @itemxxxxxx now');

    expect(msg.planItemId).toBe('itemxxxxxx');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('explicit planItemId argument wins over a mention in the body', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemAAAAAA', 'pl1');
    seedPlanItem('itemBBBBBB', 'pl1');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage(
      's1',
      'mentioning @itemAAAAAA but binding to B',
      'itemBBBBBB',
    );

    expect(msg.planItemId).toBe('itemBBBBBB');
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('ignores @<id> mentions that do not match a real plan item', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemrealxx', 'pl1');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    const msg = await sendUserMessage('s1', 'mentioning @notarealxx');

    expect(msg.planItemId).toBeNull();
    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });
});

describe('sendUserMessage — image counter', () => {
  it('increments next_image_number by the number of attached images', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'see these', null, [
      { mimeType: 'image/png', base64: 'aaaa' },
      { mimeType: 'image/jpeg', base64: 'bbbb' },
    ]);

    const row = getDb()
      .prepare('SELECT next_image_number FROM sessions WHERE id = ?')
      .get('s1') as { next_image_number: number };
    expect(row.next_image_number).toBe(3); // started at 1, +2 images

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });

  it('does not change next_image_number when no images are attached', async () => {
    setQueryImpl(() => emptyStream());
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'no images');

    const row = getDb()
      .prepare('SELECT next_image_number FROM sessions WHERE id = ?')
      .get('s1') as { next_image_number: number };
    expect(row.next_image_number).toBe(1);

    await waitFor(() => isFinishedOrError(cap.events));
    cap.stop();
  });
});

describe('sendUserMessage — error and cancel paths', () => {
  it('persists [runner error] and broadcasts run_status:error when the SDK throws', async () => {
    setQueryImpl(() => errorStream(new Error('SDK explosion')));
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'try this');

    await waitFor(() =>
      cap.events.some(
        (e) => e.type === 'run_status' && e.status === 'error',
      ),
    );

    const sysRow = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'system'`,
      )
      .get('s1') as { content: string } | undefined;
    expect(sysRow?.content).toMatch(/\[runner error\] SDK explosion/);
    cap.stop();
  });

  it('persists [cancelled by user] when cancelAiRun is called mid-run', async () => {
    setQueryImpl(abortAwaitingStream);
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'long-running task');

    // Wait for the runner to actually call query() so the abortController is wired up.
    await waitFor(() => mockQuery.mock.calls.length > 0);
    expect(cancelAiRun('s1')).toBe(true);

    await waitFor(() =>
      cap.events.some(
        (e) =>
          e.type === 'run_status' &&
          e.status === 'error' &&
          e.error === 'cancelled',
      ),
    );

    const rows = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'system'`,
      )
      .all('s1') as { content: string }[];
    expect(rows.some((r) => r.content === '[cancelled by user]')).toBe(true);
    cap.stop();
  });
});

describe('runAttempt — text streaming via stream_event', () => {
  it('persists the concatenated assistant text on stream close', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.textDelta('Hello'),
        sdk.textDelta(', '),
        sdk.textDelta('world!'),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const row = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'`,
      )
      .get('s1') as { content: string } | undefined;
    expect(row?.content).toBe('Hello, world!');
    cap.stop();
  });

  it('broadcasts a stream_chunk event for each text_delta', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.textDelta('foo'),
        sdk.textDelta('bar'),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const chunks = cap.events
      .filter((e): e is Extract<WsEvent, { type: 'stream_chunk' }> => e.type === 'stream_chunk')
      .map((e) => e.chunk);
    expect(chunks).toEqual(['foo', 'bar']);
    cap.stop();
  });

  it('captures and stamps the model the SDK reports back on the assistant row', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.textDelta('hi'),
        sdk.assistant({
          model: 'claude-sonnet-4-6',
          blocks: [{ type: 'text', text: 'hi' }],
        }),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const row = getDb()
      .prepare(
        `SELECT model FROM messages WHERE session_id = ? AND role = 'assistant'`,
      )
      .get('s1') as { model: string | null } | undefined;
    expect(row?.model).toBe('claude-sonnet-4-6');
    cap.stop();
  });

  it('forwards thinking deltas as thinking_chunk events without persisting them', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.thinkingStart(),
        sdk.thinkingDelta('reasoning step 1...'),
        sdk.thinkingDelta(' step 2'),
        sdk.textDelta('answer'),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const thinkingChunks = cap.events
      .filter((e): e is Extract<WsEvent, { type: 'thinking_chunk' }> => e.type === 'thinking_chunk')
      .map((e) => e.chunk);
    expect(thinkingChunks).toEqual(['reasoning step 1...', ' step 2']);

    // Thinking content must not leak into the persisted assistant message.
    const row = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'`,
      )
      .get('s1') as { content: string } | undefined;
    expect(row?.content).toBe('answer');
    cap.stop();
  });
});

describe('runAttempt — tool_use blocks', () => {
  it('persists a tool message with summarized content and toolUse JSON', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.assistant({
          blocks: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        }),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'list files');
    await waitFor(() => isFinishedOrError(cap.events));

    const row = getDb()
      .prepare(
        `SELECT content, tool_use FROM messages WHERE session_id = ? AND role = 'tool'`,
      )
      .get('s1') as { content: string; tool_use: string } | undefined;
    expect(row?.content).toBe('Bash: ls -la');
    expect(row?.tool_use).toBeTruthy();
    const parsed = JSON.parse(row!.tool_use) as { name: string; input: { command: string } };
    expect(parsed.name).toBe('Bash');
    expect(parsed.input.command).toBe('ls -la');

    const runLog = cap.events.find(
      (e): e is Extract<WsEvent, { type: 'run_log' }> => e.type === 'run_log',
    );
    expect(runLog?.chunk).toContain('$ Bash: ls -la');
    cap.stop();
  });

  it('closes any in-flight text stream before persisting tool_use', async () => {
    // text → tool_use should produce TWO assistant rows: the closed text one,
    // then the tool one. Tests the closeStream() call in tool_use handling.
    setQueryImpl(() =>
      streamFromMessages([
        sdk.textDelta('Looking now'),
        sdk.assistant({
          blocks: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        }),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'investigate');
    await waitFor(() => isFinishedOrError(cap.events));

    const rows = getDb()
      .prepare(
        `SELECT role, content FROM messages WHERE session_id = ? AND role IN ('assistant', 'tool') ORDER BY created_at ASC`,
      )
      .all('s1') as { role: string; content: string }[];
    expect(rows[0]).toEqual({ role: 'assistant', content: 'Looking now' });
    expect(rows[1]).toEqual({ role: 'tool', content: 'Read: /tmp/x' });
    cap.stop();
  });
});

describe('runAttempt — tool_result handling', () => {
  it('broadcasts non-error tool_result text on the stdout stream', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.toolResult('file contents here', false),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'go');
    await waitFor(() => isFinishedOrError(cap.events));

    const log = cap.events.find(
      (e): e is Extract<WsEvent, { type: 'run_log' }> =>
        e.type === 'run_log' && e.chunk.includes('file contents here'),
    );
    expect(log).toBeTruthy();
    expect(log?.stream).toBe('stdout');
    cap.stop();
  });

  it('broadcasts error tool_result on the stderr stream', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.toolResult('command not found', true),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'go');
    await waitFor(() => isFinishedOrError(cap.events));

    const log = cap.events.find(
      (e): e is Extract<WsEvent, { type: 'run_log' }> =>
        e.type === 'run_log' && e.chunk.includes('command not found'),
    );
    expect(log?.stream).toBe('stderr');
    cap.stop();
  });
});

describe('runAttempt — session_id capture', () => {
  it('persists the SDK session_id from an assistant message into sessions.claude_session_id', async () => {
    setQueryImpl(() =>
      streamFromMessages([
        sdk.assistant({
          sessionId: 'sdk-session-abc',
          blocks: [{ type: 'text', text: 'hi' }],
        }),
        sdk.textDelta('hi'),
        sdk.messageStop(),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const row = getDb()
      .prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
      .get('s1') as { claude_session_id: string };
    expect(row.claude_session_id).toBe('sdk-session-abc');
    cap.stop();
  });
});

describe('runAttempt — result subtype text fallback', () => {
  it('appends the result.result text when it exceeds what was streamed', async () => {
    // The SDK sometimes emits a final `result` with a longer string than the
    // accumulated text deltas (rare); the runner should surface the missing
    // tail rather than truncate.
    // No messageStop here: the SDK uses `result` itself as the end signal,
    // so streamMsgId is still set when result arrives and the delta
    // correctly appends to the in-flight assistant message.
    setQueryImpl(() =>
      streamFromMessages([
        sdk.textDelta('Partial'),
        sdk.result({ text: 'Partial answer with extra' }),
      ]),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi');
    await waitFor(() => isFinishedOrError(cap.events));

    const row = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'`,
      )
      .get('s1') as { content: string };
    expect(row.content).toBe('Partial answer with extra');
    cap.stop();
  });
});

describe('runAssistant — resume + fallback path', () => {
  it('clears claude_session_id and retries without resume when the resumed call throws', async () => {
    // Simulates the "session lost on SDK side" recovery: first call (resume)
    // throws, runner clears the local session id and retries from scratch
    // using buildFallbackPrompt-reconstructed history.
    let callCount = 0;
    const calls: Array<{ resume: string | undefined }> = [];
    setQueryImpl((args) => {
      callCount++;
      const opts = args.options as { resume?: string };
      calls.push({ resume: opts.resume });
      if (callCount === 1) {
        return errorStream(new Error('resume failed'));
      }
      return streamFromMessages([
        sdk.textDelta('Recovered answer'),
        sdk.messageStop(),
      ]);
    });

    seedProject('p1');
    // Pre-set claude_session_id so runAssistant takes the resume branch first.
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO sessions (id, project_id, claude_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('s1', 'p1', 'stale-session', now, now);

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'hi again');
    await waitFor(() => isFinishedOrError(cap.events));

    expect(callCount).toBe(2);
    expect(calls[0].resume).toBe('stale-session');
    expect(calls[1].resume).toBeUndefined();

    const sessionRow = getDb()
      .prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
      .get('s1') as { claude_session_id: string | null };
    expect(sessionRow.claude_session_id).toBeNull();

    const assistant = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'`,
      )
      .get('s1') as { content: string } | undefined;
    expect(assistant?.content).toBe('Recovered answer');

    const fallbackLog = cap.events.find(
      (e): e is Extract<WsEvent, { type: 'run_log' }> =>
        e.type === 'run_log' && e.chunk.includes('[resume failed'),
    );
    expect(fallbackLog?.stream).toBe('stderr');
    cap.stop();
  });
});

describe('sendUserMessage — mid-run message injection', () => {
  it('queues the second message into the same SDK call instead of restarting', async () => {
    // Two back-to-back sendUserMessage calls should reuse a single query()
    // invocation: the runner pushes the second prompt onto the AsyncIterable
    // the SDK is already consuming. The original "abort + restart" model
    // would have produced two query() calls.
    const promptsSeen: string[] = [];
    setQueryImpl(
      streamConsumingPrompts((p, idx) => {
        const block = (p as { message?: { content?: Array<{ text?: string }> } })
          .message?.content?.[0];
        if (block?.text) promptsSeen.push(block.text);
        return [
          sdk.textDelta(`reply-${idx}`),
          sdk.messageStop(),
          sdk.result({ text: `reply-${idx}` }),
        ];
      }),
    );
    seedProject('p1');
    seedSession('s1', 'p1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'first');
    // Wait for the first turn to finish (turn_complete fires `finished`).
    await waitFor(
      () =>
        cap.events.filter(
          (e) => e.type === 'run_status' && e.status === 'finished',
        ).length >= 1,
    );

    await sendUserMessage('s1', 'second');
    await waitFor(
      () =>
        cap.events.filter(
          (e) => e.type === 'run_status' && e.status === 'finished',
        ).length >= 2,
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(promptsSeen).toEqual(['first', 'second']);

    const replies = getDb()
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC`,
      )
      .all('s1') as { content: string }[];
    expect(replies.map((r) => r.content)).toEqual(['reply-0', 'reply-1']);
    cap.stop();
  });

  it('rolls over plan_item_id at turn_complete so the queued message owns its responses', async () => {
    // Mid-run injection must not bleed events from the previous turn into the
    // new plan item. The runner adopts the queued planItemId only at
    // turn_complete, so events between push and turn_complete still belong to
    // the in-flight turn.
    setQueryImpl(
      streamConsumingPrompts((_p, idx) => {
        return [
          sdk.assistant({
            blocks: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: `echo ${idx}` },
              },
            ],
          }),
          sdk.toolResult(`out ${idx}`),
          sdk.textDelta(`reply-${idx}`),
          sdk.messageStop(),
          sdk.result({ text: `reply-${idx}` }),
        ];
      }),
    );
    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemAAAAAA', 'pl1', 'A');
    seedPlanItem('itemBBBBBB', 'pl1', 'B');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'turn 1', 'itemAAAAAA');
    await waitFor(
      () =>
        cap.events.filter(
          (e) => e.type === 'run_status' && e.status === 'finished',
        ).length >= 1,
    );

    await sendUserMessage('s1', 'turn 2', 'itemBBBBBB');
    await waitFor(
      () =>
        cap.events.filter(
          (e) => e.type === 'run_status' && e.status === 'finished',
        ).length >= 2,
    );

    const rows = getDb()
      .prepare(
        `SELECT role, content, plan_item_id FROM messages
         WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all('s1') as Array<{ role: string; content: string; plan_item_id: string | null }>;

    const turn1Tool = rows.find((r) => r.role === 'tool' && r.content === 'Bash: echo 0');
    const turn1Reply = rows.find((r) => r.role === 'assistant' && r.content === 'reply-0');
    const turn2Tool = rows.find((r) => r.role === 'tool' && r.content === 'Bash: echo 1');
    const turn2Reply = rows.find((r) => r.role === 'assistant' && r.content === 'reply-1');

    expect(turn1Tool?.plan_item_id).toBe('itemAAAAAA');
    expect(turn1Reply?.plan_item_id).toBe('itemAAAAAA');
    expect(turn2Tool?.plan_item_id).toBe('itemBBBBBB');
    expect(turn2Reply?.plan_item_id).toBe('itemBBBBBB');
    cap.stop();
  });

  it('keeps in-flight events under the old plan item when a push lands mid-turn', async () => {
    // Push while inFlight=true: pending id is queued, and the runner only
    // adopts it on the NEXT turn_complete. Events that fire between push and
    // turn_complete must still belong to the in-flight turn's plan item.
    const turn1Gate = { resolve: (() => {}) as () => void };
    const turn1Wait = new Promise<void>((r) => {
      turn1Gate.resolve = r;
    });

    setQueryImpl((args) => {
      const promptIter = args.prompt as AsyncIterable<unknown>;
      return (async function* () {
        let idx = 0;
        for await (const _p of promptIter) {
          if (idx === 0) {
            // Mid-turn-1 events: the test pushes turn 2 in between these.
            yield sdk.assistant({
              blocks: [
                { type: 'tool_use', name: 'Bash', input: { command: 'echo turn1-tool' } },
              ],
            });
            // Hand control back so the test can push turn 2 while turn 1 is
            // still streaming.
            await turn1Wait;
            yield sdk.textDelta('reply-turn1');
            yield sdk.messageStop();
            yield sdk.result({ text: 'reply-turn1' });
          } else {
            yield sdk.textDelta('reply-turn2');
            yield sdk.messageStop();
            yield sdk.result({ text: 'reply-turn2' });
          }
          idx++;
        }
      })() as unknown as QueryReturn;
    });

    seedProject('p1');
    seedPlan('pl1', 'p1');
    seedPlanItem('itemAAAAAA', 'pl1', 'A');
    seedPlanItem('itemBBBBBB', 'pl1', 'B');
    seedSession('s1', 'p1', 'pl1');

    const cap = captureEvents('session:s1');
    await sendUserMessage('s1', 'turn 1', 'itemAAAAAA');

    // Wait until the tool message for turn 1 is persisted — that's our cue
    // that we're solidly mid-turn.
    await waitFor(() =>
      cap.events.some(
        (e) => e.type === 'message' && e.message.role === 'tool',
      ),
    );

    await sendUserMessage('s1', 'turn 2', 'itemBBBBBB');
    // Now release turn 1 to finish.
    turn1Gate.resolve();

    await waitFor(
      () =>
        cap.events.filter(
          (e) => e.type === 'run_status' && e.status === 'finished',
        ).length >= 2,
    );

    const rows = getDb()
      .prepare(
        `SELECT role, content, plan_item_id FROM messages
         WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all('s1') as Array<{ role: string; content: string; plan_item_id: string | null }>;

    const tool = rows.find((r) => r.role === 'tool');
    const turn1Reply = rows.find((r) => r.role === 'assistant' && r.content === 'reply-turn1');
    const turn2Reply = rows.find((r) => r.role === 'assistant' && r.content === 'reply-turn2');

    // Tool fired BEFORE the push → must stay under A.
    expect(tool?.plan_item_id).toBe('itemAAAAAA');
    // Turn 1 reply fired AFTER the push but before turn_complete → still A.
    expect(turn1Reply?.plan_item_id).toBe('itemAAAAAA');
    // Turn 2 reply fired AFTER turn_complete → B.
    expect(turn2Reply?.plan_item_id).toBe('itemBBBBBB');
    cap.stop();
  });
});
