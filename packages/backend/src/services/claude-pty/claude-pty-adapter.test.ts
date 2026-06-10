import { describe, it, expect, vi } from 'vitest';
import { createClaudePtyAdapter } from './claude-pty-adapter.js';
import { collectUuids, selectTurnLines } from '../claude-jsonl/index.js';
import type { JsonlLine } from '../claude-jsonl/index.js';
import type { ClaudeSession, ClaudeSessionFactory } from './session.js';
import type { UserPrompt } from '../agents/message-stream.js';
import type { AgentRunArgs, NormalizedEvent } from '../agents/types.js';

// A deterministic stand-in for a live `claude` REPL. It accumulates transcript
// lines the way real claude would and uses the REAL selectTurnLines parser, so
// the adapter + parser are exercised together without pty/http/fs.
class MockSession implements ClaudeSession {
  private lines: JsonlLine[] = [];
  private lastUuid: string | null = null;
  private seq = 0;
  disposed = false;
  turns = 0;

  sessionId(): string {
    return 'mock-session';
  }

  async runTurn(prompt: UserPrompt): Promise<JsonlLine[]> {
    this.turns += 1;
    const seen = collectUuids(this.lines);
    const u = `u${this.seq++}`;
    const a = `a${this.seq++}`;
    this.lines.push({
      type: 'user',
      uuid: u,
      parentUuid: this.lastUuid,
      message: { role: 'user', content: prompt.text },
    });
    this.lines.push({
      type: 'assistant',
      uuid: a,
      parentUuid: u,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: `echo: ${prompt.text}` }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    this.lastUuid = a;
    return selectTurnLines(this.lines, seen);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function makeFactory(session: ClaudeSession): ClaudeSessionFactory {
  return { start: vi.fn(async () => session) };
}

function makeArgs(overrides: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    cwd: '/tmp/proj',
    systemPrompt: 'sys',
    abortController: new AbortController(),
    initialPrompt: { text: 'hello', images: [] },
    ...overrides,
  };
}

const prompt = (text: string): UserPrompt => ({ text, images: [] });

describe('createClaudePtyAdapter', () => {
  it('streams session_id once, then one mapped turn per prompt, with mid-run injection', async () => {
    const session = new MockSession();
    const adapter = createClaudePtyAdapter(makeFactory(session));
    const run = adapter.run(makeArgs());

    const events: NormalizedEvent[] = [];
    // Consume the event stream, injecting a 2nd prompt after turn 1 completes
    // and closing after turn 2 — exactly the mid-run injection UX.
    let turnCompletes = 0;
    for await (const ev of run.events) {
      events.push(ev);
      if (ev.type === 'turn_complete') {
        turnCompletes += 1;
        if (turnCompletes === 1) run.pushMessage(prompt('again'));
        else run.close();
      }
    }

    expect(session.turns).toBe(2);
    expect(events).toEqual([
      { type: 'session_id', id: 'mock-session' },
      // turn 1
      { type: 'model', model: 'claude-opus-4-8' },
      { type: 'text_delta', text: 'echo: hello' },
      { type: 'text_block_end' },
      { type: 'turn_complete' },
      // turn 2
      { type: 'model', model: 'claude-opus-4-8' },
      { type: 'text_delta', text: 'echo: again' },
      { type: 'text_block_end' },
      { type: 'turn_complete' },
    ]);
    expect(session.disposed).toBe(true);
  });

  it('starts the session lazily exactly once', async () => {
    const session = new MockSession();
    const factory = makeFactory(session);
    const adapter = createClaudePtyAdapter(factory);
    const run = adapter.run(makeArgs());

    for await (const ev of run.events) {
      if (ev.type === 'turn_complete') run.close();
    }
    expect(factory.start).toHaveBeenCalledTimes(1);
  });

  it('disposes the session and stops on abort', async () => {
    const session = new MockSession();
    const abortController = new AbortController();
    const adapter = createClaudePtyAdapter(makeFactory(session));
    const run = adapter.run(makeArgs({ abortController }));

    const events: NormalizedEvent[] = [];
    for await (const ev of run.events) {
      events.push(ev);
      if (ev.type === 'turn_complete') {
        // abort instead of pushing/closing
        abortController.abort();
      }
    }

    expect(session.turns).toBe(1);
    expect(session.disposed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_complete' });
  });

  it('ends cleanly (no throw) when aborted mid-turn, and disposes', async () => {
    // A session whose runTurn blocks until abort, then rejects — mirrors the
    // real awaitStop rejecting on abort. The generator must end cleanly, not
    // surface the rejection to the consumer.
    class AbortingSession implements ClaudeSession {
      disposed = false;
      sessionId() {
        return 'mock';
      }
      runTurn(_p: UserPrompt, signal: AbortSignal): Promise<JsonlLine[]> {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      async dispose(): Promise<void> {
        this.disposed = true;
      }
    }
    const session = new AbortingSession();
    const abortController = new AbortController();
    const adapter = createClaudePtyAdapter(makeFactory(session));
    const run = adapter.run(makeArgs({ abortController }));

    const consume = (async () => {
      const evs: NormalizedEvent[] = [];
      for await (const ev of run.events) evs.push(ev);
      return evs;
    })();

    await new Promise((r) => setTimeout(r, 20));
    abortController.abort();

    const events = await consume; // resolves (does not reject)
    expect(session.disposed).toBe(true);
    expect(events.every((e) => e.type === 'session_id')).toBe(true);
  });

  it('passes resume + concatenated system prompt to the factory', async () => {
    const session = new MockSession();
    const factory = makeFactory(session);
    const adapter = createClaudePtyAdapter(factory);
    const run = adapter.run(
      makeArgs({ systemPrompt: 'static', systemPromptDynamic: 'dynamic', resume: 'prev-id' }),
    );
    for await (const ev of run.events) {
      if (ev.type === 'turn_complete') run.close();
    }
    expect(factory.start).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'staticdynamic', resume: 'prev-id' }),
    );
  });
});
