import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexLaunch } from './launch-spec.js';

describe('buildCodexLaunch', () => {
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'pinloom-codex-launch-'));
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('uses normal-buffer inline mode for a fresh terminal without changing option order', () => {
    const built = buildCodexLaunch({
      sessionId: 'fresh-session',
      cwd: '/tmp/project',
      systemPrompt: 'Be precise.',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      initialText: 'Continue here',
      mcpServers: {
        pinloom: {
          command: '/usr/bin/node',
          args: ['/tmp/server.js'],
          env: { PINLOOM_SESSION_ID: 'fresh-session' },
        },
      },
    });

    expect(built.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/tmp/project',
      '--no-alt-screen',
      '--model',
      'gpt-5.4',
      '-c',
      'model_reasoning_effort=high',
      'Continue here',
    ]);
    expect(built.args.filter((arg) => arg === '--no-alt-screen')).toHaveLength(1);
    expect(built.codexHome).toBe(path.join(home, '.pinloom', 'codex-homes', 'fresh-session'));
    expect(readFileSync(path.join(built.codexHome, 'AGENTS.md'), 'utf8')).toBe('Be precise.');
    const config = readFileSync(path.join(built.codexHome, 'config.toml'), 'utf8');
    expect(config).toContain('[projects."/tmp/project"]');
    expect(config).toContain('trust_level = "trusted"');
    expect(config).toContain('[mcp_servers.pinloom]');
    expect(config).toContain('command = "/usr/bin/node"');
    expect(config).toContain('args = ["/tmp/server.js"]');
    expect(config).toContain('[mcp_servers.pinloom.env]');
    expect(config).toContain('PINLOOM_SESSION_ID = "fresh-session"');

    const rebuilt = buildCodexLaunch({
      sessionId: 'fresh-session',
      cwd: '/tmp/project',
      systemPrompt: 'Updated instructions.',
    });
    expect(rebuilt.codexHome).toBe(built.codexHome);
    expect(readFileSync(path.join(rebuilt.codexHome, 'AGENTS.md'), 'utf8')).toBe(
      'Updated instructions.',
    );
  });

  it('places the inline-mode flag before resume and the native session id', () => {
    const built = buildCodexLaunch({
      sessionId: 'resume-session',
      cwd: '/tmp/project',
      systemPrompt: '',
      resume: 'native-session-id',
      initialText: 'Resume prompt',
    });

    expect(built.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/tmp/project',
      '--no-alt-screen',
      'resume',
      'native-session-id',
      'Resume prompt',
    ]);
    expect(built.args.indexOf('--no-alt-screen')).toBeLessThan(built.args.indexOf('resume'));
    expect(built.args.filter((arg) => arg === '--no-alt-screen')).toHaveLength(1);
  });
});
