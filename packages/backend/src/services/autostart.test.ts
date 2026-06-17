import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTOSTART_LABEL,
  AUTOSTART_SERVICE,
  AutostartNotBuiltError,
  AutostartUnsupportedError,
  type CommandResult,
  type CommandRunner,
  disableAutostart,
  enableAutostart,
  generateAutostartUnit,
  getAutostartStatus,
} from './autostart.js';

// A command runner that records every invocation and returns canned exit
// codes per command — so the suite never shells out to a real launchctl.
function fakeRunner(codes: Record<string, number> = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: CommandRunner = async (cmd, args): Promise<CommandResult> => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args[0] ?? ''}`.trim();
    return { code: codes[key] ?? 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pinloom-autostart-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A repoRoot with the build markers present, so assertBuilt() passes without
// `skipBuildCheck`.
function builtRepo(): string {
  const repoRoot = path.join(home, 'repo');
  mkdirSync(path.join(repoRoot, 'packages', 'frontend', 'dist'), {
    recursive: true,
  });
  mkdirSync(path.join(repoRoot, 'packages', 'backend', 'dist'), {
    recursive: true,
  });
  writeFileSync(
    path.join(repoRoot, 'packages', 'frontend', 'dist', 'index.html'),
    '<html></html>',
  );
  writeFileSync(
    path.join(repoRoot, 'packages', 'backend', 'dist', 'server.js'),
    '',
  );
  return repoRoot;
}

describe('generateAutostartUnit', () => {
  it('renders a macOS LaunchAgent plist', () => {
    const unit = generateAutostartUnit({
      platform: 'darwin',
      homeDir: home,
      repoRoot: '/Users/me/pinloom',
      shell: '/bin/zsh',
      logDir: '/Users/me/.pinloom/logs',
    });
    expect(unit).not.toBeNull();
    expect(unit!.platform).toBe('darwin');
    expect(unit!.path).toBe(
      path.join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`),
    );
    expect(unit!.content).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    // Login shell (-lc) so PATH carries pnpm/node/claude.
    expect(unit!.content).toContain('<string>/bin/zsh</string>');
    expect(unit!.content).toContain('<string>-lc</string>');
    // No-build serve command, path-free (cwd comes from WorkingDirectory).
    expect(unit!.content).toContain('<string>exec pnpm start:served</string>');
    expect(unit!.content).toContain(
      '<key>WorkingDirectory</key>\n  <string>/Users/me/pinloom</string>',
    );
    expect(unit!.content).toContain('<key>RunAtLoad</key>');
    // RunAtLoad only — never KeepAlive (no restart loop).
    expect(unit!.content).not.toContain('KeepAlive');
    expect(unit!.content).toContain(
      '<string>/Users/me/.pinloom/logs/autostart.out.log</string>',
    );
  });

  it('renders a Linux systemd --user unit', () => {
    const unit = generateAutostartUnit({
      platform: 'linux',
      homeDir: home,
      repoRoot: '/home/me/pinloom',
      shell: '/bin/bash',
      logDir: '/home/me/.pinloom/logs',
    });
    expect(unit).not.toBeNull();
    expect(unit!.platform).toBe('linux');
    expect(unit!.path).toBe(
      path.join(home, '.config', 'systemd', 'user', AUTOSTART_SERVICE),
    );
    expect(unit!.content).toContain('WantedBy=default.target');
    // cwd via WorkingDirectory; ExecStart command is path-free + single-quoted.
    expect(unit!.content).toContain('WorkingDirectory=/home/me/pinloom');
    expect(unit!.content).toContain(
      `ExecStart=/bin/bash -lc 'exec pnpm start:served'`,
    );
    expect(unit!.content).toContain('Restart=no');
  });

  it('returns null on unsupported platforms', () => {
    expect(generateAutostartUnit({ platform: 'win32' })).toBeNull();
  });

  it('passes an awkward repo path literally via WorkingDirectory', () => {
    // No shell quoting of the path at all — it only ever lands in
    // WorkingDirectory (systemd takes the value literally to end of line).
    const unit = generateAutostartUnit({
      platform: 'linux',
      homeDir: home,
      repoRoot: `/home/o'brien/pin loom`,
      shell: '/bin/bash',
    });
    expect(unit!.content).toContain(`WorkingDirectory=/home/o'brien/pin loom`);
    // The path never leaks into the shell command.
    expect(unit!.content).toContain(`ExecStart=/bin/bash -lc 'exec pnpm start:served'`);
  });
});

describe('getAutostartStatus', () => {
  it('reports unsupported platforms', async () => {
    const status = await getAutostartStatus({ platform: 'win32' });
    expect(status).toEqual({
      supported: false,
      platform: 'unsupported',
      installed: false,
      registered: false,
      unitPath: null,
    });
  });

  it('reports not-installed when the unit file is absent', async () => {
    const { run } = fakeRunner();
    const status = await getAutostartStatus({
      platform: 'darwin',
      homeDir: home,
      run,
    });
    expect(status.supported).toBe(true);
    expect(status.installed).toBe(false);
    expect(status.registered).toBe(false);
  });

  it('queries the loader only when the unit file exists', async () => {
    // Pre-create the plist so installed=true.
    const file = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${AUTOSTART_LABEL}.plist`,
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<plist/>');

    const { run, calls } = fakeRunner({ 'launchctl list': 0 });
    const status = await getAutostartStatus({
      platform: 'darwin',
      homeDir: home,
      run,
    });
    expect(status.installed).toBe(true);
    expect(status.registered).toBe(true);
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['list', AUTOSTART_LABEL],
    });
  });
});

describe('enableAutostart', () => {
  it('writes the plist and bootstraps it (macOS)', async () => {
    const repoRoot = builtRepo();
    const { run, calls } = fakeRunner();
    const result = await enableAutostart({
      platform: 'darwin',
      homeDir: home,
      repoRoot,
      uid: 501,
      shell: '/bin/zsh',
      logDir: path.join(home, '.pinloom', 'logs'),
      run,
    });

    const file = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${AUTOSTART_LABEL}.plist`,
    );
    expect(existsSync(file)).toBe(true);
    expect(result.status.installed).toBe(true);
    expect(result.warnings).toEqual([]);
    // Stale bootout first, then bootstrap into the gui domain.
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['bootout', `gui/501/${AUTOSTART_LABEL}`],
    });
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['bootstrap', 'gui/501', file],
    });
  });

  it('falls back to legacy load when bootstrap fails (macOS)', async () => {
    const repoRoot = builtRepo();
    const { run, calls } = fakeRunner({ 'launchctl bootstrap': 1 });
    const result = await enableAutostart({
      platform: 'darwin',
      homeDir: home,
      repoRoot,
      uid: 501,
      run,
    });
    expect(calls.some((c) => c.args[0] === 'load')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('enables the systemd unit (linux)', async () => {
    const repoRoot = builtRepo();
    const { run, calls } = fakeRunner();
    await enableAutostart({
      platform: 'linux',
      homeDir: home,
      repoRoot,
      run,
    });
    const file = path.join(
      home,
      '.config',
      'systemd',
      'user',
      AUTOSTART_SERVICE,
    );
    expect(existsSync(file)).toBe(true);
    expect(calls).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'enable', '--now', AUTOSTART_SERVICE],
    });
  });

  it('refuses when the app is not built', async () => {
    const repoRoot = path.join(home, 'unbuilt');
    mkdirSync(repoRoot, { recursive: true });
    const { run } = fakeRunner();
    await expect(
      enableAutostart({ platform: 'darwin', homeDir: home, repoRoot, run }),
    ).rejects.toBeInstanceOf(AutostartNotBuiltError);
  });

  it('refuses on unsupported platforms', async () => {
    await expect(
      enableAutostart({ platform: 'win32', homeDir: home }),
    ).rejects.toBeInstanceOf(AutostartUnsupportedError);
  });
});

describe('disableAutostart', () => {
  it('removes the unit file and boots it out (macOS, idempotent)', async () => {
    const file = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${AUTOSTART_LABEL}.plist`,
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<plist/>');

    const { run, calls } = fakeRunner();
    const result = await disableAutostart({
      platform: 'darwin',
      homeDir: home,
      uid: 501,
      run,
    });
    expect(existsSync(file)).toBe(false);
    expect(result.status.installed).toBe(false);
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['bootout', `gui/501/${AUTOSTART_LABEL}`],
    });

    // Disabling again with no file present must not throw.
    await expect(
      disableAutostart({ platform: 'darwin', homeDir: home, uid: 501, run }),
    ).resolves.toBeTruthy();
  });
});
