import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexDispatchResult } from './codex-pty/agent-terminal.js';
import { getDb } from '../db/connection.js';

const runtime = vi.hoisted(() => ({
  aiRunning: vi.fn(() => false),
  execRunning: vi.fn(() => false),
  terminalBusy: vi.fn(() => false),
  defaultCheckpoint: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('./runner.js', () => ({ isAiRunning: runtime.aiRunning }));
vi.mock('./exec.js', () => ({ isExecRunning: runtime.execRunning }));
vi.mock('./codex-pty/agent-terminal.js', () => ({
  isCodexTerminalBusy: runtime.terminalBusy,
  requestCodexTerminalCheckpoint: runtime.defaultCheckpoint,
}));
vi.mock('../ws/hub.js', () => ({ broadcast: runtime.broadcast }));

import {
  CHECKPOINT_MIDDLE_OMITTED,
  CODEX_ROLLOVER_PROMPT,
  CodexRolloverError,
  rolloverCodexSession,
} from './codex-rollover.js';

let sequence = 0;

function insertProject(): string {
  const id = `rollover-project-${sequence++}`;
  const now = '2026-08-11T00:00:00.000Z';
  getDb().prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Rollover project', '/tmp/rollover-project', now, now);
  return id;
}

function insertSession(overrides: {
  id?: string;
  projectId?: string;
  planId?: string | null;
  agent?: string;
  transport?: string | null;
  botKind?: string | null;
  title?: string | null;
  orderIndex?: number;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
} = {}): string {
  const id = overrides.id ?? `rollover-session-${sequence++}`;
  const projectId = overrides.projectId ?? insertProject();
  const now = '2026-08-11T00:00:00.000Z';
  getDb().prepare(
    `INSERT INTO sessions (
       id, project_id, plan_id, agent, transport, bot_kind, title, order_index,
       agent_session_id, claude_session_id, model, reasoning_effort, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.planId ?? null,
    overrides.agent ?? 'codex',
    overrides.transport ?? 'terminal',
    overrides.botKind ?? null,
    Object.hasOwn(overrides, 'title') ? overrides.title : 'Long session',
    overrides.orderIndex ?? 0,
    overrides.agentSessionId ?? 'codex-resume',
    overrides.claudeSessionId ?? 'legacy-resume',
    overrides.model ?? 'gpt-5.4',
    overrides.reasoningEffort ?? 'high',
    now,
    now,
  );
  return id;
}

function checkpoint(reply: string): (
  sessionId: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<CodexDispatchResult> {
  return vi.fn(async () => ({ ok: true, reply }));
}

function destinationCount(sourceId: string): number {
  return (getDb().prepare(
    'SELECT COUNT(*) AS count FROM sessions WHERE source_session_id = ?',
  ).get(sourceId) as { count: number }).count;
}

beforeEach(() => {
  getDb().exec(`
    DELETE FROM team_members;
    DELETE FROM teams;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM plans;
    DELETE FROM projects;
  `);
  runtime.aiRunning.mockReset().mockReturnValue(false);
  runtime.execRunning.mockReset().mockReturnValue(false);
  runtime.terminalBusy.mockReset().mockReturnValue(false);
  runtime.defaultCheckpoint.mockReset();
  runtime.broadcast.mockReset();
});

describe('rolloverCodexSession preconditions', () => {
  it('uses the fixed structured prompt with the code-unit limit', () => {
    expect(CODEX_ROLLOVER_PROMPT).toContain('12,000');
    expect(CODEX_ROLLOVER_PROMPT).toContain('Respond in concise Markdown');
    expect(CODEX_ROLLOVER_PROMPT).toContain('## Current objective and progress');
    expect(CODEX_ROLLOVER_PROMPT).toContain('## Decisions and constraints');
    expect(CODEX_ROLLOVER_PROMPT).toContain('## Changed files and relevant commands');
    expect(CODEX_ROLLOVER_PROMPT).toContain('## Open work and next action');
    expect(CODEX_ROLLOVER_PROMPT).toContain('## Failures, gotchas, and verification state');
  });

  it('returns a 404-class error for a missing source', async () => {
    await expect(rolloverCodexSession('missing', { requestCheckpoint: checkpoint('x') }))
      .rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['non-Codex session', { agent: 'claude' }],
    ['non-terminal session', { transport: 'sdk' }],
    ['bot session', { botKind: 'schedule' }],
  ])('returns a 400-class error for a %s', async (_label, overrides) => {
    const sourceId = insertSession(overrides);
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('x') }))
      .rejects.toMatchObject({ status: 400 });
    expect(destinationCount(sourceId)).toBe(0);
  });

  it.each(['orchestrator', 'worker'] as const)(
    'returns a 400-class error for a team %s',
    async (role) => {
      const projectId = insertProject();
      const sourceId = insertSession({ projectId });
      const otherId = insertSession({ projectId, id: `other-${sequence++}` });
      const now = '2026-08-11T00:00:00.000Z';
      const orchestratorId = role === 'orchestrator' ? sourceId : otherId;
      getDb().prepare(
        'INSERT INTO teams (id, name, orchestrator_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(`team-${sequence++}`, 'Team', orchestratorId, now, now);
      if (role === 'worker') {
        const team = getDb().prepare('SELECT id FROM teams WHERE orchestrator_session_id = ?')
          .get(otherId) as { id: string };
        getDb().prepare(
          'INSERT INTO team_members (team_id, session_id, alias, created_at) VALUES (?, ?, ?, ?)',
        ).run(team.id, sourceId, 'worker', now);
      }

      await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('x') }))
        .rejects.toMatchObject({ status: 400 });
    },
  );

  it.each(['ai', 'shell', 'terminal'] as const)(
    'returns a 409-class error while %s work is running',
    async (kind) => {
      const sourceId = insertSession();
      if (kind === 'ai') runtime.aiRunning.mockReturnValue(true);
      if (kind === 'shell') runtime.execRunning.mockReturnValue(true);
      if (kind === 'terminal') runtime.terminalBusy.mockReturnValue(true);

      await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('x') }))
        .rejects.toMatchObject({ status: 409 });
      expect(destinationCount(sourceId)).toBe(0);
    },
  );

  it('rejects a concurrent second rollover and clears the in-flight guard', async () => {
    const sourceId = insertSession();
    let resolveCheckpoint: ((value: CodexDispatchResult) => void) | null = null;
    const provider = vi.fn(
      () => new Promise<CodexDispatchResult>((resolve) => {
        resolveCheckpoint = resolve;
      }),
    );

    const first = rolloverCodexSession(sourceId, { requestCheckpoint: provider });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: provider }))
      .rejects.toMatchObject({ status: 409 });

    resolveCheckpoint?.({ ok: true, reply: 'first checkpoint' });
    await first;
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('again') }))
      .resolves.toMatchObject({ projectId: expect.any(String) });
  });

  it('maps a terminal busy race after initial validation to 409', async () => {
    const sourceId = insertSession();
    const provider = vi.fn(async () => ({
      ok: false,
      kind: 'busy',
      error: 'codex terminal busy',
    }) as unknown as CodexDispatchResult);

    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: provider }))
      .rejects.toMatchObject({ status: 409 });
    expect(destinationCount(sourceId)).toBe(0);
  });
});

describe('rolloverCodexSession persistence', () => {
  it.each([
    ['timeout', vi.fn(async () => ({ ok: false as const, error: 'codex turn timed out' }))],
    ['provider failure', vi.fn(async () => { throw new Error('provider crashed'); })],
    ['empty reply', checkpoint('  \n  ')],
  ])('does not create a destination after %s', async (_label, provider) => {
    const sourceId = insertSession();
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: provider }))
      .rejects.toBeInstanceOf(CodexRolloverError);
    expect(destinationCount(sourceId)).toBe(0);
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('retry') }))
      .resolves.toMatchObject({ projectId: expect.any(String) });
  });

  it('uses the fallback title for an untitled source', async () => {
    const sourceId = insertSession({ title: null });
    await expect(rolloverCodexSession(sourceId, { requestCheckpoint: checkpoint('ready') }))
      .resolves.toMatchObject({ title: 'Continued session' });
  });

  it('preserves a trimmed 16,000-code-unit reply exactly', async () => {
    const sourceId = insertSession();
    const content = 'x'.repeat(16_000);
    const created = await rolloverCodexSession(sourceId, {
      requestCheckpoint: checkpoint(content),
    });

    const row = getDb().prepare(
      "SELECT content FROM messages WHERE session_id = ? AND pin_title = 'Rollover checkpoint'",
    ).get(created.id) as { content: string };
    expect(row.content).toBe(content);
  });

  it('bounds a 16,001-code-unit reply to its first 12,000 and final 4,000 units', async () => {
    const sourceId = insertSession();
    const content = `${'a'.repeat(12_000)}Z${'b'.repeat(4_000)}`;
    const created = await rolloverCodexSession(sourceId, {
      requestCheckpoint: checkpoint(content),
    });

    const row = getDb().prepare(
      "SELECT content FROM messages WHERE session_id = ? AND pin_title = 'Rollover checkpoint'",
    ).get(created.id) as { content: string };
    expect(row.content).toBe(
      `${'a'.repeat(12_000)}${CHECKPOINT_MIDDLE_OMITTED}${'b'.repeat(4_000)}`,
    );
  });

  it('creates a fresh inherited session, ordered pin copies, and a pinned checkpoint', async () => {
    const projectId = insertProject();
    const planId = `rollover-plan-${sequence++}`;
    const now = '2026-08-11T00:00:00.000Z';
    getDb().prepare(
      'INSERT INTO plans (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(planId, projectId, 'Plan', 'active', now, now);
    const sourceId = insertSession({
      projectId,
      planId,
      title: 'Deep work',
      orderIndex: 3,
      agentSessionId: 'source-agent-resume',
      claudeSessionId: 'source-legacy-resume',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
    });
    insertSession({ projectId, id: `later-${sequence++}`, orderIndex: 7 });
    const insertPin = getDb().prepare(
      `INSERT INTO messages (
         id, session_id, role, content, pinned, pin_title, pinned_at, created_at
       ) VALUES (?, ?, 'assistant', ?, 1, ?, ?, ?)`,
    );
    insertPin.run('pin-a', sourceId, 'alpha', 'Alpha', '2026-08-11T01:00:00.000Z', '2026-08-11T02:00:00.000Z');
    insertPin.run('pin-b', sourceId, 'beta', 'Beta', '2026-08-11T02:00:00.000Z', '2026-08-11T01:00:00.000Z');
    const provider = checkpoint('  generated checkpoint  ');

    const created = await rolloverCodexSession(sourceId, { requestCheckpoint: provider });

    expect(provider).toHaveBeenCalledWith(
      sourceId,
      CODEX_ROLLOVER_PROMPT,
      expect.any(AbortSignal),
      expect.any(Number),
    );
    expect(created).toMatchObject({
      projectId,
      planId,
      agent: 'codex',
      title: 'Deep work (continued)',
      agentSessionId: null,
      claudeSessionId: null,
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      transport: 'terminal',
    });
    const destination = getDb().prepare(
      `SELECT source_session_id, order_index, agent_session_id, claude_session_id
       FROM sessions WHERE id = ?`,
    ).get(created.id);
    expect(destination).toEqual({
      source_session_id: sourceId,
      order_index: 8,
      agent_session_id: null,
      claude_session_id: null,
    });
    expect(getDb().prepare(
      `SELECT content, pin_title, source_message_id
       FROM messages WHERE session_id = ? ORDER BY rowid`,
    ).all(created.id)).toEqual([
      { content: 'alpha', pin_title: 'Alpha', source_message_id: 'pin-a' },
      { content: 'beta', pin_title: 'Beta', source_message_id: 'pin-b' },
      { content: 'generated checkpoint', pin_title: 'Rollover checkpoint', source_message_id: null },
    ]);
    expect(getDb().prepare(
      'SELECT agent_session_id, claude_session_id FROM sessions WHERE id = ?',
    ).get(sourceId)).toEqual({
      agent_session_id: 'source-agent-resume',
      claude_session_id: 'source-legacy-resume',
    });
    expect(getDb().prepare(
      'SELECT id, content FROM messages WHERE session_id = ? ORDER BY rowid',
    ).all(sourceId)).toEqual([
      { id: 'pin-a', content: 'alpha' },
      { id: 'pin-b', content: 'beta' },
    ]);
    const copiedRows = getDb().prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    ).all(created.id) as Array<{
      id: string;
      session_id: string;
      plan_item_id: string | null;
      role: 'assistant';
      content: string;
      tool_use: string | null;
      pinned: number;
      pin_title: string | null;
      pinned_at: string | null;
      source_message_id: string | null;
      model: string | null;
      created_at: string;
    }>;
    const copiedMessages = copiedRows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      planItemId: row.plan_item_id,
      role: row.role,
      content: row.content,
      toolUse: row.tool_use,
      pinned: row.pinned === 1,
      pinTitle: row.pin_title,
      pinnedAt: row.pinned_at,
      sourceMessageId: row.source_message_id,
      model: row.model,
      createdAt: row.created_at,
    }));
    expect(runtime.broadcast.mock.calls).toEqual([
      [
        `session:${created.id}`,
        { type: 'message', sessionId: created.id, message: copiedMessages[0] },
      ],
      [
        `session:${created.id}`,
        { type: 'message', sessionId: created.id, message: copiedMessages[1] },
      ],
      [
        `session:${created.id}`,
        { type: 'message', sessionId: created.id, message: copiedMessages[2] },
      ],
      [
        `project:${projectId}`,
        { type: 'session_created', projectId, session: created },
      ],
    ]);
  });

  it.each([
    ['deleted', 404, (sourceId: string) => {
      getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sourceId);
    }],
    ['non-Codex', 400, (sourceId: string) => {
      getDb().prepare("UPDATE sessions SET agent = 'claude' WHERE id = ?").run(sourceId);
    }],
    ['non-terminal', 400, (sourceId: string) => {
      getDb().prepare("UPDATE sessions SET transport = 'sdk' WHERE id = ?").run(sourceId);
    }],
    ['bot', 400, (sourceId: string) => {
      getDb().prepare("UPDATE sessions SET bot_kind = 'schedule' WHERE id = ?").run(sourceId);
    }],
    ['team orchestrator', 400, (sourceId: string) => {
      const now = '2026-08-11T00:00:00.000Z';
      getDb().prepare(
        'INSERT INTO teams (id, name, orchestrator_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(`late-team-${sequence++}`, 'Late team', sourceId, now, now);
    }],
    ['team worker', 400, (sourceId: string) => {
      const projectId = (getDb().prepare('SELECT project_id FROM sessions WHERE id = ?')
        .get(sourceId) as { project_id: string }).project_id;
      const orchestratorId = insertSession({ projectId, id: `late-orchestrator-${sequence++}` });
      const teamId = `late-team-${sequence++}`;
      const now = '2026-08-11T00:00:00.000Z';
      getDb().prepare(
        'INSERT INTO teams (id, name, orchestrator_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(teamId, 'Late team', orchestratorId, now, now);
      getDb().prepare(
        'INSERT INTO team_members (team_id, session_id, alias, created_at) VALUES (?, ?, ?, ?)',
      ).run(teamId, sourceId, 'late-worker', now);
    }],
    ['terminal busy', 409, (_sourceId: string) => {
      runtime.terminalBusy.mockReturnValue(true);
    }],
    ['AI busy', 409, (_sourceId: string) => {
      runtime.aiRunning.mockReturnValue(true);
    }],
    ['shell busy', 409, (_sourceId: string) => {
      runtime.execRunning.mockReturnValue(true);
    }],
  ] as const)(
    'revalidates a source that becomes %s while the checkpoint is pending',
    async (_label, status, mutate) => {
      const sourceId = insertSession();
      const provider = vi.fn(async () => {
        mutate(sourceId);
        return { ok: true as const, reply: 'checkpoint generated first' };
      });

      await expect(rolloverCodexSession(sourceId, { requestCheckpoint: provider }))
        .rejects.toMatchObject({ status });
      expect(destinationCount(sourceId)).toBe(0);
    },
  );

  it('uses refreshed source metadata and the pin set present after checkpoint generation', async () => {
    const projectId = insertProject();
    const sourceId = insertSession({ projectId, title: 'Before', model: 'before-model' });
    getDb().prepare(
      `INSERT INTO messages (
         id, session_id, role, content, pinned, pin_title, pinned_at, created_at
       ) VALUES (?, ?, 'assistant', ?, 1, ?, ?, ?)`,
    ).run('pin-before', sourceId, 'before pin', 'Before pin', '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:00.000Z');
    const provider = vi.fn(async () => {
      getDb().prepare('UPDATE sessions SET title = ?, model = ?, reasoning_effort = ? WHERE id = ?')
        .run('After', 'after-model', 'low', sourceId);
      getDb().prepare('UPDATE messages SET pinned = 0 WHERE id = ?').run('pin-before');
      getDb().prepare(
        `INSERT INTO messages (
           id, session_id, role, content, pinned, pin_title, pinned_at, created_at
         ) VALUES (?, ?, 'assistant', ?, 1, ?, ?, ?)`,
      ).run('pin-after', sourceId, 'after pin', 'After pin', '2026-08-11T02:00:00.000Z', '2026-08-11T02:00:00.000Z');
      return { ok: true as const, reply: 'fresh checkpoint' };
    });

    const created = await rolloverCodexSession(sourceId, { requestCheckpoint: provider });

    expect(created).toMatchObject({
      title: 'After (continued)',
      model: 'after-model',
      reasoningEffort: 'low',
    });
    expect(getDb().prepare(
      'SELECT content, source_message_id FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    ).all(created.id)).toEqual([
      { content: 'after pin', source_message_id: 'pin-after' },
      { content: 'fresh checkpoint', source_message_id: null },
    ]);
  });

  it('returns the committed Session and attempts every broadcast when broadcasts throw', async () => {
    const sourceId = insertSession();
    getDb().prepare(
      `INSERT INTO messages (
         id, session_id, role, content, pinned, pin_title, pinned_at, created_at
       ) VALUES (?, ?, 'assistant', ?, 1, ?, ?, ?)`,
    ).run('broadcast-pin', sourceId, 'pin', 'Pin', '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:00.000Z');
    runtime.broadcast.mockImplementation(() => {
      throw new Error('socket failure');
    });

    const created = await rolloverCodexSession(sourceId, {
      requestCheckpoint: checkpoint('checkpoint'),
    });

    expect(created.id).toEqual(expect.any(String));
    expect(destinationCount(sourceId)).toBe(1);
    expect(runtime.broadcast).toHaveBeenCalledTimes(3);
  });

  it('rolls back the destination and copied pins when checkpoint insertion fails', async () => {
    const sourceId = insertSession();
    getDb().prepare(
      `INSERT INTO messages (
         id, session_id, role, content, pinned, pin_title, pinned_at, created_at
       ) VALUES (?, ?, 'assistant', ?, 1, ?, ?, ?)`,
    ).run('rollback-pin', sourceId, 'keep me', 'Keep', '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:00.000Z');
    getDb().exec(`
      CREATE TEMP TRIGGER fail_rollover_checkpoint
      BEFORE INSERT ON messages
      WHEN NEW.pin_title = 'Rollover checkpoint'
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint insertion failed');
      END;
    `);
    const provider = checkpoint('generated before transaction');

    try {
      await expect(rolloverCodexSession(sourceId, { requestCheckpoint: provider }))
        .rejects.toBeInstanceOf(Error);
      expect(provider).toHaveBeenCalledOnce();
      expect(destinationCount(sourceId)).toBe(0);
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id <> ?',
      ).get(sourceId)).toEqual({ count: 0 });
      expect(runtime.broadcast).not.toHaveBeenCalled();
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_rollover_checkpoint;');
    }
  });
});
