// Login autostart — register pinloom to launch when the user logs in, so an
// installed PWA window (see frontend hooks/usePwaInstall) opens to a live
// backend instead of a dead port. User-scoped only: a macOS LaunchAgent or a
// systemd --user unit, both reversible by toggling off. No sudo, no system
// services, no privilege escalation.
//
// Design notes (agreed with a Codex + architect review):
//   - The unit runs `pnpm start:served`, NOT `pnpm start`. `start` has a
//     `prestart: pnpm build` that would rebuild the whole monorepo on every
//     login (and on every KeepAlive restart). `start:served` serves the
//     existing build, so login is fast and a crash-restart can't build-storm.
//   - We run it through a LOGIN shell (`zsh -lc` / `bash -lc`) AND bake the
//     enabling backend's own PATH into the unit. launchd and systemd start
//     with a bare environment; pnpm/node and the agent CLIs (claude/codex)
//     live on the user's PATH. A login shell only sources login files
//     (.zprofile/.zshenv) — NOT .zshrc/.bashrc — yet asdf/nvm/fnm/volta etc.
//     install their PATH setup into the *interactive* rc file by default, so
//     `-l` alone leaves pnpm unresolved and every spawn ENOENTs (the unit
//     dies at login with code 127). Capturing `process.env.PATH` at enable
//     time — the PATH that already lets THIS backend find pnpm/claude/codex —
//     sidesteps the version-manager-in-.zshrc trap regardless of shell setup.
//   - RunAtLoad only, no KeepAlive. This mirrors "the user starts it once at
//     login and leaves it running" — the current manual behavior — and can't
//     enter a restart loop. Crash-supervision can be a later opt-in.
//   - The source of truth is the OS, not our DB: status() always re-reads the
//     unit file + queries launchctl/systemctl, because the user can unload it
//     out-of-band.
//
// Everything external (target paths, command runner, platform, uid) is
// injectable so the test suite can exercise unit generation + the install
// flow against a tmpdir with a stubbed runner — it never touches the real
// ~/Library/LaunchAgents or calls launchctl.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const AUTOSTART_LABEL = 'io.pinloom.app';
export const AUTOSTART_SERVICE = 'pinloom.service';

export type AutostartPlatform = 'darwin' | 'linux' | 'unsupported';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs a command and resolves (never rejects) with its exit code + output, so
// "this unit isn't loaded" (a nonzero exit) is data, not an exception.
export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
    };
  }
};

export interface AutostartDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  /** Monorepo root the unit will `cd` into. */
  repoRoot: string;
  uid: number;
  /** Login shell used to inherit the user's PATH. */
  shell: string;
  /**
   * PATH baked into the unit's environment so login (non-interactive) shells
   * resolve pnpm/node/claude/codex even when the toolchain is set up in the
   * interactive rc file (.zshrc/.bashrc) rather than a login file. Defaults to
   * the enabling backend's own PATH, which by definition already works.
   */
  pathEnv: string;
  logDir: string;
  run: CommandRunner;
  /**
   * Skip the "is the app built?" guard. Production needs the guard (serving an
   * unbuilt tree fails at login); tests set this so a tmp repoRoot is enough.
   */
  skipBuildCheck: boolean;
}

function resolveDeps(overrides: Partial<AutostartDeps> = {}): AutostartDeps {
  const platform = overrides.platform ?? process.platform;
  const homeDir = overrides.homeDir ?? os.homedir();
  // Matches db/connection.ts: the backend runs with cwd = packages/backend,
  // so the monorepo root is two levels up.
  const repoRoot = overrides.repoRoot ?? path.resolve(process.cwd(), '../..');
  const defaultShell =
    process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return {
    platform,
    homeDir,
    repoRoot,
    uid: overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    shell: overrides.shell ?? defaultShell,
    pathEnv: overrides.pathEnv ?? process.env.PATH ?? '',
    logDir: overrides.logDir ?? path.join(homeDir, '.pinloom', 'logs'),
    run: overrides.run ?? defaultRunner,
    skipBuildCheck: overrides.skipBuildCheck ?? false,
  };
}

function platformKind(platform: NodeJS.Platform): AutostartPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

function unitPath(d: AutostartDeps): string {
  if (d.platform === 'darwin') {
    return path.join(
      d.homeDir,
      'Library',
      'LaunchAgents',
      `${AUTOSTART_LABEL}.plist`,
    );
  }
  return path.join(
    d.homeDir,
    '.config',
    'systemd',
    'user',
    AUTOSTART_SERVICE,
  );
}

// Wrap a value in single quotes for POSIX sh, escaping embedded single quotes.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Escape a value for a systemd double-quoted setting (Environment="KEY=val").
// systemd treats `\` and `"` specially inside the quotes; spaces are already
// covered by the surrounding quotes. Backslash first so we don't double-escape.
function systemdQuoteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// The shell command launchd/systemd executes. Deliberately path-free: the repo
// directory is supplied via the unit's WorkingDirectory (taken literally by
// both launchd and systemd, no shell quoting), which sidesteps systemd's
// fragile ExecStart quote parsing entirely. `exec` replaces the shell so a
// stop signal reaches pnpm/concurrently directly.
const LAUNCH_COMMAND = 'exec pnpm start:served';

function outLog(d: AutostartDeps): string {
  return path.join(d.logDir, 'autostart.out.log');
}
function errLog(d: AutostartDeps): string {
  return path.join(d.logDir, 'autostart.err.log');
}

// A launchd <key>EnvironmentVariables</key> dict carrying PATH, emitted only
// when we actually have one to bake (empty PATH would clobber, not help).
function plistEnvironment(d: AutostartDeps): string {
  if (!d.pathEnv) return '';
  return `  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(d.pathEnv)}</string>
  </dict>
`;
}

function plistContent(d: AutostartDeps): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(d.shell)}</string>
    <string>-lc</string>
    <string>${xmlEscape(LAUNCH_COMMAND)}</string>
  </array>
${plistEnvironment(d)}  <key>WorkingDirectory</key>
  <string>${xmlEscape(d.repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog(d))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog(d))}</string>
</dict>
</plist>
`;
}

function systemdContent(d: AutostartDeps): string {
  return `[Unit]
Description=pinloom local Claude Code workspace
After=network.target

[Service]
Type=simple
WorkingDirectory=${d.repoRoot}
${d.pathEnv ? `Environment="PATH=${systemdQuoteValue(d.pathEnv)}"\n` : ''}ExecStart=${d.shell} -lc ${shQuote(LAUNCH_COMMAND)}
Restart=no
StandardOutput=append:${outLog(d)}
StandardError=append:${errLog(d)}

[Install]
WantedBy=default.target
`;
}

/** Render the unit file content for the current platform (no side effects). */
export function generateAutostartUnit(
  overrides: Partial<AutostartDeps> = {},
): { platform: AutostartPlatform; path: string; content: string } | null {
  const d = resolveDeps(overrides);
  const kind = platformKind(d.platform);
  if (kind === 'unsupported') return null;
  return {
    platform: kind,
    path: unitPath(d),
    content: kind === 'darwin' ? plistContent(d) : systemdContent(d),
  };
}

export interface AutostartStatus {
  supported: boolean;
  platform: AutostartPlatform;
  /** The unit file exists on disk (our intent marker). */
  installed: boolean;
  /** launchctl/systemctl reports the unit loaded/enabled (best effort). */
  registered: boolean;
  /** Absolute path of the unit file (null on unsupported platforms). */
  unitPath: string | null;
}

async function isRegistered(d: AutostartDeps): Promise<boolean> {
  if (d.platform === 'darwin') {
    const r = await d.run('launchctl', ['list', AUTOSTART_LABEL]);
    return r.code === 0;
  }
  if (d.platform === 'linux') {
    const r = await d.run('systemctl', ['--user', 'is-enabled', AUTOSTART_SERVICE]);
    return r.code === 0;
  }
  return false;
}

export async function getAutostartStatus(
  overrides: Partial<AutostartDeps> = {},
): Promise<AutostartStatus> {
  const d = resolveDeps(overrides);
  const kind = platformKind(d.platform);
  if (kind === 'unsupported') {
    return {
      supported: false,
      platform: kind,
      installed: false,
      registered: false,
      unitPath: null,
    };
  }
  const file = unitPath(d);
  const installed = existsSync(file);
  return {
    supported: true,
    platform: kind,
    installed,
    registered: installed ? await isRegistered(d) : false,
    unitPath: file,
  };
}

export class AutostartUnsupportedError extends Error {}
export class AutostartNotBuiltError extends Error {}

function assertBuilt(d: AutostartDeps): void {
  if (d.skipBuildCheck) return;
  const frontendShell = path.join(
    d.repoRoot,
    'packages',
    'frontend',
    'dist',
    'index.html',
  );
  const backendEntry = path.join(
    d.repoRoot,
    'packages',
    'backend',
    'dist',
    'server.js',
  );
  if (!existsSync(frontendShell) || !existsSync(backendEntry)) {
    throw new AutostartNotBuiltError(
      'pinloom is not built yet. Run `pnpm build` once, then enable autostart.',
    );
  }
}

// Register the unit with the OS after writing it. Returns any non-fatal
// stderr so the UI can surface "installed, but the loader complained".
async function register(d: AutostartDeps, file: string): Promise<string[]> {
  const warnings: string[] = [];
  if (d.platform === 'darwin') {
    const domain = `gui/${d.uid}`;
    // Re-enabling: bootout a stale instance first so bootstrap doesn't fail
    // with "service already loaded". Ignore its result.
    await d.run('launchctl', ['bootout', `${domain}/${AUTOSTART_LABEL}`]);
    const r = await d.run('launchctl', ['bootstrap', domain, file]);
    if (r.code !== 0) {
      // Older macOS: fall back to the legacy verb.
      const legacy = await d.run('launchctl', ['load', '-w', file]);
      if (legacy.code !== 0) {
        warnings.push(r.stderr || legacy.stderr || 'launchctl bootstrap failed');
      }
    }
  } else {
    const reload = await d.run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0 && reload.stderr) warnings.push(reload.stderr);
    const enable = await d.run('systemctl', [
      '--user',
      'enable',
      '--now',
      AUTOSTART_SERVICE,
    ]);
    if (enable.code !== 0) {
      warnings.push(enable.stderr || 'systemctl enable failed');
    }
  }
  return warnings;
}

async function unregister(d: AutostartDeps, file: string): Promise<void> {
  if (d.platform === 'darwin') {
    await d.run('launchctl', ['bootout', `gui/${d.uid}/${AUTOSTART_LABEL}`]);
    // Legacy fallback is harmless if the modern verb already worked.
    await d.run('launchctl', ['unload', file]);
  } else {
    await d.run('systemctl', ['--user', 'disable', '--now', AUTOSTART_SERVICE]);
    await d.run('systemctl', ['--user', 'daemon-reload']);
  }
}

export interface AutostartActionResult {
  status: AutostartStatus;
  warnings: string[];
}

export async function enableAutostart(
  overrides: Partial<AutostartDeps> = {},
): Promise<AutostartActionResult> {
  const d = resolveDeps(overrides);
  const kind = platformKind(d.platform);
  if (kind === 'unsupported') {
    throw new AutostartUnsupportedError(
      `Login autostart isn't supported on ${d.platform}.`,
    );
  }
  assertBuilt(d);

  const file = unitPath(d);
  mkdirSync(d.logDir, { recursive: true });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    kind === 'darwin' ? plistContent(d) : systemdContent(d),
    'utf8',
  );

  const warnings = await register(d, file);
  return { status: await getAutostartStatus(overrides), warnings };
}

export async function disableAutostart(
  overrides: Partial<AutostartDeps> = {},
): Promise<AutostartActionResult> {
  const d = resolveDeps(overrides);
  const kind = platformKind(d.platform);
  if (kind === 'unsupported') {
    throw new AutostartUnsupportedError(
      `Login autostart isn't supported on ${d.platform}.`,
    );
  }
  const file = unitPath(d);
  await unregister(d, file);
  // rmSync(force) is a no-op if the unit was already gone — disable stays
  // idempotent.
  rmSync(file, { force: true });
  return { status: await getAutostartStatus(overrides), warnings: [] };
}
