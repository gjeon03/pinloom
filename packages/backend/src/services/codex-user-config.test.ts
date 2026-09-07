import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractMcpServerTables,
  inheritedMcpServerToml,
  splitDottedKey,
} from './codex-user-config.js';

describe('splitDottedKey', () => {
  it('splits bare segments', () => {
    expect(splitDottedKey('mcp_servers.playwright.tools.browser_resize')).toEqual([
      'mcp_servers',
      'playwright',
      'tools',
      'browser_resize',
    ]);
  });

  it('keeps a dot inside a quoted segment', () => {
    expect(splitDottedKey('projects."/Users/me/a.b/c"')).toEqual([
      'projects',
      '/Users/me/a.b/c',
    ]);
  });

  it('handles literal quotes and surrounding whitespace', () => {
    expect(splitDottedKey(" mcp_servers . 'my server' ")).toEqual([
      'mcp_servers',
      'my server',
    ]);
  });
});

describe('extractMcpServerTables', () => {
  it('keeps every mcp_servers table verbatim and drops everything else', () => {
    const config = [
      'model = "gpt-5.6-sol"',
      'personality = "friendly"',
      '',
      '[features]',
      'codex_hooks = true',
      '',
      '[mcp_servers.context7]',
      'url = "https://mcp.context7.com/mcp"',
      '',
      '[mcp_servers.playwright]',
      'args = [ "@playwright/mcp@latest" ]',
      'command = "npx"',
      '',
      '[mcp_servers.playwright.tools.browser_resize]',
      'approval_mode = "approve"',
      '',
      '[projects."/tmp/x"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    const blocks = extractMcpServerTables(config, new Set());
    expect(blocks).toEqual([
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"',
      '[mcp_servers.playwright]\nargs = [ "@playwright/mcp@latest" ]\ncommand = "npx"',
      '[mcp_servers.playwright.tools.browser_resize]\napproval_mode = "approve"',
    ]);
  });

  it('drops excluded server names, including their sub-tables', () => {
    const config = [
      '[mcp_servers.pinloom]',
      'command = "/usr/bin/node"',
      '',
      '[mcp_servers.pinloom.env]',
      'PINLOOM_TOKEN = "user-copy"',
      '',
      '[mcp_servers.memory]',
      'command = "npx"',
    ].join('\n');

    expect(extractMcpServerTables(config, new Set(['pinloom']))).toEqual([
      '[mcp_servers.memory]\ncommand = "npx"',
    ]);
  });

  it('does not treat a bracket inside a multi-line string as a table header', () => {
    const config = [
      '[mcp_servers.notes]',
      'command = "npx"',
      'instructions = """',
      '[mcp_servers.evil]',
      'command = "rm"',
      '"""',
      '',
      '[plugins."docs"]',
      'enabled = true',
    ].join('\n');

    expect(extractMcpServerTables(config, new Set())).toEqual([
      '[mcp_servers.notes]\ncommand = "npx"\ninstructions = """\n[mcp_servers.evil]\ncommand = "rm"\n"""',
    ]);
  });

  it('ignores a bare [mcp_servers] table with no server name', () => {
    expect(extractMcpServerTables('[mcp_servers]\n', new Set())).toEqual([]);
  });
});

describe('inheritedMcpServerToml', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'pinloom-codex-user-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns an appendable fragment for the user servers', () => {
    writeFileSync(
      path.join(home, 'config.toml'),
      '[mcp_servers.memory]\ncommand = "npx"\n',
      'utf8',
    );
    const toml = inheritedMcpServerToml(home, ['pinloom']);
    expect(toml).toContain('[mcp_servers.memory]');
    expect(toml).toContain('command = "npx"');
    expect(toml.startsWith('#')).toBe(true); // provenance comment leads the block
  });

  it('is empty when the user has no config file', () => {
    expect(inheritedMcpServerToml(home)).toBe('');
  });

  it('is empty when the user config declares no servers', () => {
    writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
    expect(inheritedMcpServerToml(home)).toBe('');
  });
});
