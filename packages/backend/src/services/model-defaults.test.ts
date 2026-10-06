import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { codexAdapter } from './agents/codex-adapter.js';
import { distillDay } from './timeline/distill.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('SDK model defaults', () => {
  it.each([undefined, 'explicit-model'])('loads Claude settings and honors an override (%s)', async (model) => {
    vi.mocked(query).mockImplementation(() => (async function* () {
      yield { type: 'result', subtype: 'success', result: '# Entry' };
    })() as ReturnType<typeof query>);

    await distillDay(
      { projectName: 'Demo', date: '2026-10-06', sessions: [], commits: [], existingEntry: null },
      { model },
    );

    const options = vi.mocked(query).mock.calls[0][0].options;
    expect(options?.settingSources).toEqual(['user', 'project', 'local']);
    if (model) expect(options?.model).toBe(model);
    else expect(options).not.toHaveProperty('model');
  });

  it.each([undefined, 'explicit-model'])('inherits Codex defaults for orchestrators (%s)', async (model) => {
    const sourceHome = mkdtempSync(path.join(tmpdir(), 'pinloom-model-defaults-'));
    vi.stubEnv('CODEX_HOME', sourceHome);
    writeFileSync(path.join(sourceHome, 'config.toml'), [
      'model = "user-default"',
      'model_reasoning_effort = "high"',
    ].join('\n'));

    let inherited = '';
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      const generatedHome = options?.env?.CODEX_HOME;
      expect(generatedHome).toBeTruthy();
      expect(generatedHome).not.toBe(sourceHome);
      inherited = readFileSync(path.join(generatedHome!, 'config.toml'), 'utf8');
      const stdout = new PassThrough();
      stdout.end('{"type":"turn.completed"}\n');
      return {
        stdin: new PassThrough(), stdout, stderr: new PassThrough(),
        exitCode: 0, kill: vi.fn(),
      } as unknown as ReturnType<typeof spawn>;
    });

    const run = codexAdapter.run({
      cwd: sourceHome,
      systemPrompt: '',
      initialPrompt: { text: 'Hello' },
      abortController: new AbortController(),
      model,
      mcpServers: { pinloom: { command: 'node', args: ['server.js'] } },
    });
    try {
      for await (const event of run.events) {
        if (event.type === 'turn_complete') break;
      }
      expect(inherited).toContain('model = "user-default"');
      expect(inherited).toContain('model_reasoning_effort = "high"');
      expect(inherited.indexOf('model =')).toBeLessThan(inherited.indexOf('[mcp_servers.'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      if (model) expect(args).toEqual(expect.arrayContaining(['--model', model]));
      else expect(args).not.toContain('--model');
    } finally {
      run.close();
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });
});
