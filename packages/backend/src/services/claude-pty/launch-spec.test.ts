import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildClaudeLaunch } from './launch-spec.js';

const URL = 'http://127.0.0.1:5555/stop/tok';

describe('buildClaudeLaunch', () => {
  it('always sets isolated settings, setting-sources, and skip-permissions', () => {
    const b = buildClaudeLaunch({ systemPrompt: '' }, URL);
    expect(b.args).toContain('--settings');
    expect(b.args).toContain('--setting-sources');
    expect(b.args[b.args.indexOf('--setting-sources') + 1]).toBe('user,project');
    expect(b.args).toContain('--dangerously-skip-permissions');
    b.cleanup();
  });

  it('writes a temp Stop-hook settings file whose command points at the url', () => {
    const b = buildClaudeLaunch({ systemPrompt: 'sys' }, URL);
    const settingsPath = b.args[b.args.indexOf('--settings') + 1];
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain(URL);
    expect(cmd).toContain('stop-forward.mjs');
    b.cleanup();
    expect(existsSync(settingsPath)).toBe(false); // cleanup removed the temp dir
  });

  it('writes the claude TUI theme into settings when given (omits it otherwise)', () => {
    const lit = buildClaudeLaunch({ systemPrompt: 's', theme: 'light' }, URL);
    const litSettings = JSON.parse(
      readFileSync(lit.args[lit.args.indexOf('--settings') + 1], 'utf8'),
    );
    expect(litSettings.theme).toBe('light');
    lit.cleanup();

    const none = buildClaudeLaunch({ systemPrompt: 's' }, URL);
    const noneSettings = JSON.parse(
      readFileSync(none.args[none.args.indexOf('--settings') + 1], 'utf8'),
    );
    expect('theme' in noneSettings).toBe(false);
    none.cleanup();
  });

  it('maps model, effort, resume, and seeds a positional prompt', () => {
    const b = buildClaudeLaunch(
      {
        systemPrompt: 'sys',
        model: 'claude-opus-4-8',
        reasoningEffort: 'high',
        resume: 'sess-1',
        initialText: 'do the thing',
      },
      URL,
    );
    const a = b.args;
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('sys');
    expect(a[a.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(a[a.indexOf('--effort') + 1]).toBe('high');
    expect(a[a.indexOf('--resume') + 1]).toBe('sess-1');
    // positional prompt is the last arg
    expect(a[a.length - 1]).toBe('do the thing');
    b.cleanup();
  });

  it('omits the positional when initialText is empty/absent, and writes mcp config when given', () => {
    const b = buildClaudeLaunch(
      { systemPrompt: 'sys', mcpServers: { pinloom: { command: 'node', args: ['x'] } } },
      URL,
    );
    expect(b.args).toContain('--mcp-config');
    const mcpPath = b.args[b.args.indexOf('--mcp-config') + 1];
    expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.pinloom.command).toBe('node');
    // no positional (no initialText)
    expect(b.args.at(-1)).not.toBe('sys');
    b.cleanup();
  });
});
