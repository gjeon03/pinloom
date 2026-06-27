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
   * Positional [prompt] to seed the first turn (works for fresh AND `--resume`).
   * Null/undefined = no positional (e.g. terminal mode where the human types).
   */
  initialText?: string | null;
  /**
   * Claude TUI colour theme, mirrored from the app theme so the TUI paints its
   * own UI chrome (input box, dividers) light-on-light instead of dark fills
   * that show as black bars on a light terminal. Undefined = leave to claude.
   */
  theme?: 'light' | 'dark';
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
  const command = opts.pinloomSessionId
    ? `node ${JSON.stringify(forwarderPath)} ${JSON.stringify(stopHookUrl)} ${JSON.stringify(opts.pinloomSessionId)}`
    : `node ${JSON.stringify(forwarderPath)} ${JSON.stringify(stopHookUrl)}`;

  const settingsPath = path.join(tmp, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
        // Mirror the app theme so the claude TUI's own UI chrome matches the
        // terminal background (no black bars on a light terminal). The explicit
        // --settings file outranks the user's global theme for this session.
        ...(input.theme ? { theme: input.theme } : {}),
      },
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
