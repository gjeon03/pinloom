import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractMcpServerTables,
  inheritedMcpServerToml,
  inheritedModelToml,
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
    expect(inheritedModelToml(home)).toBe('');
  });

  it('inherits model defaults and providers without unrelated settings or nested model keys', () => {
    writeFileSync(path.join(home, 'config.toml'), [
      '# An example delimiter: """',
      'instructions = """',
      'model = "not-a-setting"',
      '[not-a-table]',
      '"""',
      '"model" = "configured-model"',
      "'model_reasoning_effort' = 'high'",
      'model_provider = "custom"',
      'model_context_window = 200000',
      'model_auto_compact_token_limit = 180000',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      '[model_providers.custom]',
      'name = "Custom provider"',
      'base_url = "https://example.com/v1"',
      '[plugins.docs]',
      'enabled = true',
      '[projects."/tmp/project"]',
      'model = "nested-model"',
    ].join('\n'));

    const inherited = inheritedModelToml(home);
    expect(inherited).toContain('"model" = "configured-model"');
    expect(inherited).toContain("'model_reasoning_effort' = 'high'");
    expect(inherited).toContain('model_context_window = 200000');
    expect(inherited).toContain('model_auto_compact_token_limit = 180000');
    expect(inherited).toContain('service_tier = "fast"');
    expect(inherited).toContain('[model_providers.custom]');
    expect(inherited).toContain('base_url = "https://example.com/v1"');
    expect(inherited).not.toContain('not-a-setting');
    expect(inherited).not.toContain('nested-model');
    expect(inherited).not.toContain('approval_policy');
    expect(inherited).not.toContain('[plugins');
  });

  it('is empty when the user config declares no servers', () => {
    writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
    expect(inheritedMcpServerToml(home)).toBe('');
  });

  it.each([
    'model_providers = { custom = { name = "Custom", base_url = "https://example.com/v1" } }',
    'model_providers.custom.name = "Custom"\nmodel_providers.custom.base_url = "https://example.com/v1"',
  ])('retains root-level provider definitions (%s)', (provider) => {
    writeFileSync(path.join(home, 'config.toml'), [
      'model_provider = "custom"',
      provider,
      '[features]',
      'multi_agent = true',
    ].join('\n'));
    const inherited = inheritedModelToml(home);
    expect(inherited).toContain('model_provider = "custom"');
    expect(inherited).toContain(provider);
    expect(inherited).not.toContain('[features]');
  });
});
