// Shared "how to launch claude" builder: writes the per-session temp dir
// (isolated Stop-hook settings + forwarder + optional mcp config) and assembles
// the argv. ONE source of truth so the PTY adapter (node-session.ts), terminal
// mode (agent-terminal.ts), and any future caller spawn claude identically.
//
// NEVER touches the user's global ~/.claude/settings.json — the Stop hook lives
// only in the temp `--settings` file; `--setting-sources user,project` still
// loads the user's own config alongside it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpStdioServerConfig } from '../agents/types.js';

// ESM forwarder claude's Stop hook executes: reads the hook JSON on stdin and
// POSTs it to our localhost server. `fetch` is a Node global (>=18).
const FORWARDER_SRC = `let d='';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', async () => {
  try { await fetch(process.argv[2], { method: 'POST', body: d || '{}' }); } catch {}
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
): BuiltClaudeLaunch {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pinloom-claude-pty-'));

  const forwarderPath = path.join(tmp, 'stop-forward.mjs');
  writeFileSync(forwarderPath, FORWARDER_SRC, 'utf8');

  const settingsPath = path.join(tmp, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node ${JSON.stringify(forwarderPath)} ${JSON.stringify(stopHookUrl)}`,
                },
              ],
            },
          ],
        },
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
