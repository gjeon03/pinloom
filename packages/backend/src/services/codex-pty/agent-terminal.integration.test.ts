import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';

const fakes = vi.hoisted(() => {
  const ptys: FakePty[] = [];
  return {
    ptys,
    captureCompletion: null as (() => void) | null,
    awaitTurn: vi.fn(),
    submit: vi.fn(),
    broadcast: vi.fn(),
    emitRunStatus: vi.fn(),
    events: [] as string[],
  };
});

class FakePty {
  readonly pid = 4321;
  readonly writes: string[] = [];
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
    return { dispose() {} };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.exitListener?.({ exitCode: 0 });
  }

  pause(): void {}

  resume(): void {}

  clear(): void {}

  emitData(data: string): void {
    this.dataListener?.(data);
  }
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const instance = new FakePty();
    fakes.ptys.push(instance);
    return instance as unknown as IPty;
  }),
}));

vi.mock('../runner.js', () => ({
  buildSessionLaunchInput: vi.fn((sessionId: string) => ({
    cwd: '/tmp',
    systemPrompt: '',
    model: null,
    reasoningEffort: null,
    resume: null,
    mcpServers: {},
    sessionId,
  })),
  emitRunStatus: fakes.emitRunStatus,
  emitWorkerStatusIfMember: vi.fn(),
}));

vi.mock('../../ws/hub.js', () => ({ broadcast: fakes.broadcast }));

vi.mock('./launch-spec.js', () => ({
  buildCodexLaunch: vi.fn(() => ({
    args: [],
    codexHome: '/tmp/fake-codex-home',
    cleanup: vi.fn(),
  })),
  codexHomeFor: vi.fn((sessionId: string) => `/tmp/fake-codex-home/${sessionId}`),
}));

vi.mock('./transcript-capture.js', () => ({
  startCodexCapture: vi.fn(
    (_sessionId: string, _codexHome: string, _resume: string | null, onComplete?: () => void) => {
      fakes.captureCompletion = onComplete ?? null;
    },
  ),
  stopCodexCapture: vi.fn(),
  awaitCodexTurn: (...args: unknown[]) => {
    fakes.events.push('waiter');
    return fakes.awaitTurn(...args);
  },
}));

vi.mock('../claude-pty/tui-input.js', () => ({
  submitToTui: (...args: unknown[]) => {
    fakes.events.push('submit');
    return fakes.submit(...args);
  },
}));

import {
  attachCodexTerminal,
  codexTerminalLock,
  isCodexTerminalBusy,
  killCodexTerminal,
  requestCodexTerminalCheckpoint,
  spawnCodexTerminal,
} from './agent-terminal.js';

const sessionIds = new Set<string>();
let sequence = 0;

async function createTerminal() {
  const sessionId = `checkpoint-terminal-${sequence++}`;
  sessionIds.add(sessionId);
  await spawnCodexTerminal(sessionId, 120, 40);
  const attached = await attachCodexTerminal(sessionId, 120, 40, vi.fn(), vi.fn());
  if (!attached.ok) throw new Error(attached.reason);
  return { sessionId, handle: attached.handle, pty: fakes.ptys.at(-1)! };
}

beforeEach(() => {
  fakes.ptys.length = 0;
  fakes.captureCompletion = null;
  fakes.awaitTurn.mockReset();
  fakes.submit.mockReset();
  fakes.broadcast.mockReset();
  fakes.emitRunStatus.mockReset();
  fakes.events.length = 0;
  fakes.submit.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const sessionId of sessionIds) killCodexTerminal(sessionId);
  sessionIds.clear();
});

describe('exclusive Codex checkpoint dispatch', () => {
  it('fails a missing terminal without cold-starting it', async () => {
    const spawnedBefore = fakes.ptys.length;

    await expect(
      requestCodexTerminalCheckpoint(
        'missing-terminal',
        'checkpoint',
        new AbortController().signal,
        100,
      ),
    ).resolves.toEqual({ ok: false, kind: 'missing', error: 'codex terminal not found' });
    expect(fakes.ptys).toHaveLength(spawnedBefore);
    expect(fakes.awaitTurn).not.toHaveBeenCalled();
  });

  it('rejects a human turn in flight and resets it at capture completion', async () => {
    const { sessionId, handle } = await createTerminal();
    handle.write('\r');
    expect(isCodexTerminalBusy(sessionId)).toBe(true);

    await expect(
      requestCodexTerminalCheckpoint(
        sessionId,
        'checkpoint',
        new AbortController().signal,
        100,
      ),
    ).resolves.toEqual({ ok: false, kind: 'busy', error: 'codex terminal busy' });

    fakes.captureCompletion?.();
    expect(isCodexTerminalBusy(sessionId)).toBe(false);
  });

  it('locks human input, arms the waiter before submit, and returns the matching reply', async () => {
    const { sessionId, handle, pty } = await createTerminal();
    let resolveTurn: ((reply: string) => void) | null = null;
    fakes.awaitTurn.mockImplementation(
      () => new Promise<string>((resolve) => {
        resolveTurn = resolve;
      }),
    );

    const pending = requestCodexTerminalCheckpoint(
      sessionId,
      'checkpoint prompt',
      new AbortController().signal,
      1000,
    );
    await vi.waitFor(() => expect(codexTerminalLock(sessionId)).toBe('dispatch'));
    expect(isCodexTerminalBusy(sessionId)).toBe(true);

    handle.write('blocked human input');
    expect(pty.writes).toEqual([]);
    await vi.waitFor(() => expect(fakes.events).toEqual(['waiter', 'submit']));

    fakes.captureCompletion?.();
    resolveTurn?.('fresh checkpoint');
    await expect(pending).resolves.toEqual({ ok: true, reply: 'fresh checkpoint' });
    expect(codexTerminalLock(sessionId)).toBeNull();
    expect(isCodexTerminalBusy(sessionId)).toBe(false);
  });

  it('rejects a second dispatch while the checkpoint owns the chain', async () => {
    const { sessionId } = await createTerminal();
    let resolveTurn: ((reply: string) => void) | null = null;
    fakes.awaitTurn.mockImplementation(
      () => new Promise<string>((resolve) => {
        resolveTurn = resolve;
      }),
    );

    const first = requestCodexTerminalCheckpoint(
      sessionId,
      'first',
      new AbortController().signal,
      1000,
    );
    await vi.waitFor(() => expect(codexTerminalLock(sessionId)).toBe('dispatch'));
    await vi.waitFor(() => expect(fakes.events).toEqual(['waiter', 'submit']));
    await expect(
      requestCodexTerminalCheckpoint(
        sessionId,
        'second',
        new AbortController().signal,
        1000,
      ),
    ).resolves.toEqual({ ok: false, kind: 'busy', error: 'codex terminal busy' });

    fakes.captureCompletion?.();
    resolveTurn?.('done');
    await first;
  });

  it.each(['timeout', 'abort', 'submit throw'] as const)(
    'unlocks after %s',
    async (failure) => {
      const { sessionId } = await createTerminal();
      const controller = new AbortController();
      if (failure === 'timeout') {
        fakes.awaitTurn.mockRejectedValue(new Error('codex turn timed out after 5ms'));
      } else if (failure === 'abort') {
        fakes.awaitTurn.mockImplementation(
          (_id: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        );
      } else {
        fakes.awaitTurn.mockReturnValue(new Promise<string>(() => {}));
        fakes.submit.mockRejectedValue(new Error('input failed'));
      }

      const pending = requestCodexTerminalCheckpoint(
        sessionId,
        'checkpoint',
        controller.signal,
        5,
      );
      await vi.waitFor(() => expect(codexTerminalLock(sessionId)).toBe('dispatch'));
      if (failure === 'abort') controller.abort();

      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(codexTerminalLock(sessionId)).toBeNull();
      if (failure === 'submit throw') {
        expect(isCodexTerminalBusy(sessionId)).toBe(false);
        expect(fakes.emitRunStatus).toHaveBeenLastCalledWith(sessionId, 'error', 'input failed');
      }

      fakes.captureCompletion?.();
      fakes.awaitTurn.mockResolvedValue('retry checkpoint');
      fakes.submit.mockResolvedValue(undefined);
      await expect(requestCodexTerminalCheckpoint(
        sessionId,
        'retry',
        new AbortController().signal,
        100,
      )).resolves.toEqual({ ok: true, reply: 'retry checkpoint' });
      fakes.captureCompletion?.();
    },
  );

  it('keeps lock state safe when lock and unlock broadcasts throw', async () => {
    const { sessionId } = await createTerminal();
    fakes.broadcast.mockImplementation(() => {
      throw new Error('socket failed');
    });
    fakes.awaitTurn.mockResolvedValue('checkpoint despite socket failure');

    await expect(requestCodexTerminalCheckpoint(
      sessionId,
      'checkpoint',
      new AbortController().signal,
      1000,
    )).resolves.toEqual({ ok: true, reply: 'checkpoint despite socket failure' });

    fakes.captureCompletion?.();
    expect(codexTerminalLock(sessionId)).toBeNull();
    expect(fakes.broadcast).toHaveBeenCalledTimes(2);
  });
});
