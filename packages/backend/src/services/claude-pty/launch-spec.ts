// Shared "how to launch claude" builder: writes the per-session temp dir
// (isolated Stop-hook settings + forwarder + optional mcp config) and assembles
// the argv. ONE source of truth so the PTY adapter (node-session.ts), terminal
// mode (agent-terminal.ts), and any future caller spawn claude identically.
//
// NEVER touches the user's global ~/.claude/settings.json — the Stop hook lives
// only in the temp `--settings` file; `--setting-sources user,project` still
// loads the user's own config alongside it.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { McpStdioServerConfig } from '../agents/types.js';

/**
 * Pre-accept the claude folder-trust dialog for `cwd`. The interactive TUI
 * prompts "Do you trust this folder?" on first launch in a directory, and
 * `--dangerously-skip-permissions` does NOT cover it (that flag is about
 * file R/W/exec, not trust). For a human attach the user just clicks through,
 * but a dispatch cold-start has no human → the seeded prompt never runs and
 * the orchestrator blocks until timeout. codex pre-trusts via config.toml;
 * this is the claude analog — write the trust flags into ~/.claude.json the
 * way the CLI itself records an accepted dialog.
 *
 * Best-effort: realpath the cwd (claude keys trust on the resolved path, and
 * /tmp→/private/tmp etc. would otherwise miss), skip the write if already
 * trusted, and swallow any error (the human can still accept the dialog).
 * Opening a project in pinloom is itself the user's intent to trust its cwd.
 */
export function preTrustClaudeCwd(cwd: string): void {
  try {
    const real = realpathSync(cwd);
    const f = path.join(homedir(), '.claude.json');
    const cfg: { projects?: Record<string, Record<string, unknown>> } =
      existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    cfg.projects = cfg.projects ?? {};
    const cur = cfg.projects[real] ?? {};
    if (cur.hasTrustDialogAccepted && cur.hasCompletedProjectOnboarding) {
      return; // already trusted — avoid a needless read-modify-write race
    }
    cfg.projects[real] = {
      ...cur,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    writeFileSync(f, JSON.stringify(cfg));
  } catch {
    // best-effort — fall back to the human accepting the dialog
  }
}

// ESM forwarder claude's Stop hook executes: reads the hook JSON on stdin and
// POSTs it to our localhost server, merging in OUR pinloom session id (argv[3],
// optional) so the server can map claude's session_id back to the pinloom
// session without a dir-diff. `fetch` is a Node global (>=18).
const FORWARDER_SRC = `let d='';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', async () => {
  let payload = {};
  try { payload = JSON.parse(d || '{}'); } catch {}
  if (process.argv[3]) payload.pinloom_session_id = process.argv[3];
  try { await fetch(process.argv[2], { method: 'POST', body: JSON.stringify(payload) }); } catch {}
  process.exit(0);
});
`;

export interface ClaudeLaunchInput {
  /** Full system prompt (static + dynamic concatenated — TUI has no cache split). */
  systemPrompt: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Prior sessionId to `--resume`; null/undefined = fresh. */
  resume?: string | null;
  mcpServers?: Record<string, McpStdioServerConfig>;
  /**
   * Pass `--strict-mcp-config` so claude uses ONLY the servers from our
   * `--mcp-config` (or none, if we pass none) and ignores the user/project MCP
   * from `--setting-sources`. Set for team WORKERS: they are headless task
   * runners that don't need the human's global MCP (playwright/omc/…), and each
   * inherited server is an extra child process per worker — which fans out hard
   * under team mode. Only affects MCP resolution; CLAUDE.md / permissions / hooks
   * from the setting-sources still load. Left off for interactive sessions.
   */
  strictMcp?: boolean;
  /**
   * Positional [prompt] to seed the first turn (works for fresh AND `--resume`).
   * Null/undefined = no positional (e.g. terminal mode where the human types).
   */
  initialText?: string | null;
}

export interface BuiltClaudeLaunch {
  /** argv to pass to pty.spawn(bin, args, …). */
  args: string[];
  /** The per-session temp dir (also holds materialized images, etc.). */
  tmpDir: string;
  /** Remove the temp dir. Idempotent, best-effort. */
  cleanup(): void;
}

/**
 * Build the Stop-hook command string. Uses the backend's OWN node binary by
 * ABSOLUTE path (`process.execPath`), never a bare `node`: a bare `node`
 * resolves against claude's PATH, which in the desktop app is a login-shell PATH
 * where a broken homebrew node can shadow the working one → the forwarder dies
 * before POSTing → 0 captured turns + null claude_session_id (issue #188).
 *
 * When the backend runs under Electron, `process.execPath` is the Electron
 * binary, so the command MUST carry `ELECTRON_RUN_AS_NODE=1` or every Stop hook
 * would boot a GUI Electron instead of running node (worse than the silent
 * failure). Mirrors the MCP-child pattern in runner.ts. Pure + exported so the
 * absolute-path and electron-prefix invariants are unit-tested.
 */
export function buildStopHookCommand(
  nodeExecPath: string,
  isElectron: boolean,
  forwarderPath: string,
  stopHookUrl: string,
  pinloomSessionId?: string,
): string {
  const nodeBin = JSON.stringify(nodeExecPath);
  const envPrefix = isElectron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  const fwdArgs = pinloomSessionId
    ? `${JSON.stringify(forwarderPath)} ${JSON.stringify(stopHookUrl)} ${JSON.stringify(pinloomSessionId)}`
    : `${JSON.stringify(forwarderPath)} ${JSON.stringify(stopHookUrl)}`;
  return `${envPrefix}${nodeBin} ${fwdArgs}`;
}

/**
 * Build the temp launch environment + argv for an interactive `claude`. The Stop
 * hook in the generated settings POSTs to `stopHookUrl`.
 */
export function buildClaudeLaunch(
  input: ClaudeLaunchInput,
  stopHookUrl: string,
  opts: { pinloomSessionId?: string } = {},
): BuiltClaudeLaunch {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pinloom-claude-pty-'));

  const forwarderPath = path.join(tmp, 'stop-forward.mjs');
  writeFileSync(forwarderPath, FORWARDER_SRC, 'utf8');

  // The Stop-hook command forwards the payload to our server, tagging it with
  // the pinloom session id (3rd arg) so terminal-mode capture can map it back.
  const command = buildStopHookCommand(
    process.execPath,
    Boolean(process.versions.electron),
    forwarderPath,
    stopHookUrl,
    opts.pinloomSessionId,
  );

  const settingsPath = path.join(tmp, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } },
      null,
      2,
    ),
    'utf8',
  );

  let mcpPath: string | null = null;
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    mcpPath = path.join(tmp, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: input.mcpServers }, null, 2), 'utf8');
  }

  const args: string[] = [
    // Isolate OUR Stop hook here; keep the user's own config loading too.
    '--settings',
    settingsPath,
    '--setting-sources',
    'user,project',
    // Non-interactive automation: no permission prompts.
    '--dangerously-skip-permissions',
  ];
  if (input.systemPrompt.length > 0) {
    args.push('--append-system-prompt', input.systemPrompt);
  }
  if (input.model) args.push('--model', input.model);
  // claude's --effort accepts the same low/medium/high/xhigh/max tokens.
  if (input.reasoningEffort) args.push('--effort', input.reasoningEffort);
  if (mcpPath) args.push('--mcp-config', mcpPath);
  // Workers: ignore user/project MCP entirely (only --mcp-config servers, if any,
  // survive). Must come alongside --mcp-config so the orchestrator's pinloom
  // server isn't stripped too, but workers pass no mcpPath → zero MCP servers.
  if (input.strictMcp) args.push('--strict-mcp-config');
  if (input.resume) args.push('--resume', input.resume);
  // Positional [prompt]: seeds the first turn so the (fresh OR resumed) session
  // auto-runs it instead of us typing into the freshly-launched TUI.
  if (input.initialText && input.initialText.length > 0) {
    args.push(input.initialText);
  }

  return {
    args,
    tmpDir: tmp,
    cleanup() {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
