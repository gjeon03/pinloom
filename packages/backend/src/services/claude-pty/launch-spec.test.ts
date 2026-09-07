import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { buildClaudeLaunch, buildStopHookCommand, claudePtyDirFor } from './launch-spec.js';

const URL = 'http://127.0.0.1:5555/stop/tok';

// Issue #188: the Stop-hook command must use an ABSOLUTE node path (not a bare
// `node` that resolves against claude's possibly-broken PATH in the app), and
// when running under Electron must carry ELECTRON_RUN_AS_NODE=1 (or each hook
// boots a GUI Electron).
describe('buildStopHookCommand', () => {
  const FWD = '/tmp/pinloom-x/stop-forward.mjs';

  it('uses the absolute node exec path, never a bare `node`', () => {
    const cmd = buildStopHookCommand('/abs/path/to/node', false, FWD, URL, 'sid-1');
    expect(cmd).toContain('"/abs/path/to/node"');
    expect(cmd).not.toMatch(/^node /);
    expect(cmd).not.toMatch(/(^|[^/"])node /); // no bare `node ` token anywhere
    expect(cmd).toContain(FWD);
    expect(cmd).toContain(URL);
    expect(cmd).toContain('sid-1');
  });

  it('prefixes ELECTRON_RUN_AS_NODE=1 when running under Electron', () => {
    const cmd = buildStopHookCommand('/Applications/pinloom.app/.../Electron', true, FWD, URL);
    expect(cmd.startsWith('ELECTRON_RUN_AS_NODE=1 ')).toBe(true);
  });

  it('omits the Electron prefix on a plain node backend', () => {
    const cmd = buildStopHookCommand('/usr/bin/node', false, FWD, URL);
    expect(cmd).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('omits the pinloom session id arg when not given', () => {
    const withId = buildStopHookCommand('/usr/bin/node', false, FWD, URL, 'sid-2');
    const without = buildStopHookCommand('/usr/bin/node', false, FWD, URL);
    expect(withId).toContain('sid-2');
    expect(without).not.toContain('sid-2');
  });
});

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

  it('adds --strict-mcp-config only when strictMcp is set (worker sessions)', () => {
    const off = buildClaudeLaunch({ systemPrompt: 'sys' }, URL);
    expect(off.args).not.toContain('--strict-mcp-config');
    off.cleanup();

    const on = buildClaudeLaunch({ systemPrompt: 'sys', strictMcp: true }, URL);
    expect(on.args).toContain('--strict-mcp-config');
    on.cleanup();
  });
});

describe('stable launch dir (terminal mode)', () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(nodePath.join(tmpdir(), 'pinloom-claude-stable-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the dir under ~/.pinloom, out of the $TMPDIR macOS reaps', () => {
    const b = buildClaudeLaunch({ systemPrompt: '' }, URL, {
      pinloomSessionId: 'sess-1',
      stableDir: true,
    });
    expect(b.tmpDir).toBe(claudePtyDirFor('sess-1'));
    expect(b.tmpDir).toContain(nodePath.join('.pinloom', 'claude-pty'));
    // (HOME is redirected into a tmpdir here, so asserting "not under $TMPDIR"
    // would be meaningless — the path shape above is what matters.)
    expect(existsSync(nodePath.join(b.tmpDir, 'stop-forward.mjs'))).toBe(true);
    expect(existsSync(nodePath.join(b.tmpDir, 'settings.json'))).toBe(true);
  });

  it('reuses the same dir across spawns of one session', () => {
    const first = buildClaudeLaunch({ systemPrompt: 'a' }, URL, {
      pinloomSessionId: 'sess-1',
      stableDir: true,
    });
    const second = buildClaudeLaunch({ systemPrompt: 'b' }, URL, {
      pinloomSessionId: 'sess-1',
      stableDir: true,
    });
    expect(second.tmpDir).toBe(first.tmpDir);
  });

  it('drops a previous spawn\'s mcp.json when the new one has no servers', () => {
    const withMcp = buildClaudeLaunch(
      { systemPrompt: '', mcpServers: { pinloom: { command: 'node', args: ['s.js'] } } },
      URL,
      { pinloomSessionId: 'sess-1', stableDir: true },
    );
    const mcpFile = nodePath.join(withMcp.tmpDir, 'mcp.json');
    expect(existsSync(mcpFile)).toBe(true);

    buildClaudeLaunch({ systemPrompt: '' }, URL, {
      pinloomSessionId: 'sess-1',
      stableDir: true,
    });
    expect(existsSync(mcpFile)).toBe(false);
  });

  it('still uses a temp dir without the opt-in (per-run node-session spawns)', () => {
    const b = buildClaudeLaunch({ systemPrompt: '' }, URL, { pinloomSessionId: 'sess-1' });
    expect(b.tmpDir).not.toBe(claudePtyDirFor('sess-1'));
    expect(nodePath.basename(b.tmpDir)).toMatch(/^pinloom-claude-pty-/);
    b.cleanup();
    expect(existsSync(b.tmpDir)).toBe(false);
  });
});
