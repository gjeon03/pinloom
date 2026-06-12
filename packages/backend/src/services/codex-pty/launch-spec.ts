// "How to launch an interactive codex" builder for codex terminal mode — the
// codex analog of claude-pty/launch-spec.ts. Unlike claude (temp --settings dir +
// Stop hook), codex configures via a per-session $CODEX_HOME containing a
// generated config.toml. Differences from claude that this file encodes:
//   - completion/capture come from the rollout file under $CODEX_HOME/sessions
//     (a rollout-tail watcher, not a Stop hook), so NO forwarder/hook here.
//   - directory trust is granted via `[projects."<cwd>"] trust_level="trusted"`
//     in config.toml (codex's analog of claude's hasTrustDialogAccepted), so the
//     headless TUI doesn't block on the trust dialog.
//   - the system prompt is delivered as $CODEX_HOME/AGENTS.md (codex loads it as
//     global instructions) since codex has no --append-system-prompt.
//   - the CODEX_HOME is STABLE per session (~/.pinloom/codex-homes/<id>), not a
//     mkdtemp that's cleaned on teardown, so `codex resume <id>` can find the
//     rollout across reconnects/restarts.
//
// NEVER touches the user's real ~/.codex — we point CODEX_HOME at our own dir and
// only copy auth.json over so the spawned codex stays logged in.

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { McpStdioServerConfig } from '../agents/types.js';

// TOML string escaping — mirrors codex-adapter.ts's helper (duplicated, not
// imported, to keep the adapter byte-identical; both are tiny pure functions).
function tomlString(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else out += ch;
  }
  return `"${out}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export interface CodexLaunchInput {
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Prior codex session id to `codex resume <id>`; null = fresh. */
  resume?: string | null;
  mcpServers?: Record<string, McpStdioServerConfig>;
  /** Positional [prompt] to seed the first turn (auto-runs); null = none. */
  initialText?: string | null;
}

export interface BuiltCodexLaunch {
  /** argv for pty.spawn(codexBin, args, …). */
  args: string[];
  /** The per-session CODEX_HOME (stable — holds config.toml + sessions/rollout). */
  codexHome: string;
  /** Best-effort cleanup of transient files (NOT the stable home). No-op today. */
  cleanup(): void;
}

/** The stable per-session CODEX_HOME (persists across spawns for `codex resume`). */
export function codexHomeFor(sessionId: string): string {
  return path.join(homedir(), '.pinloom', 'codex-homes', sessionId);
}

/**
 * Materialize the per-session CODEX_HOME (auth, config.toml with dir-trust + MCP,
 * AGENTS.md system prompt) and assemble the interactive `codex` argv.
 */
export function buildCodexLaunch(input: CodexLaunchInput): BuiltCodexLaunch {
  const codexHome = codexHomeFor(input.sessionId);
  // 0700: this dir holds a copy of the user's auth.json (token at rest). Mirror
  // codex-adapter's mkdtemp (owner-only) — don't leave it umask-default (0755).
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try {
    chmodSync(codexHome, 0o700); // tighten a pre-existing dir (recursive mkdir skips mode on those)
  } catch {
    // best-effort
  }

  // Keep the spawned codex logged in by copying the user's auth (refresh each spawn).
  const sourceHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  for (const filename of ['auth.json', 'auth.json.bak']) {
    const src = path.join(sourceHome, filename);
    if (existsSync(src)) {
      try {
        copyFileSync(src, path.join(codexHome, filename));
      } catch {
        // best-effort — codex surfaces its own auth errors if missing
      }
    }
  }

  // config.toml: pre-trust the cwd (so the headless TUI skips the trust dialog and
  // can load our config), enable hooks off, and declare our MCP server(s).
  const lines: string[] = [];
  lines.push(`[projects.${tomlString(input.cwd)}]`);
  lines.push('trust_level = "trusted"');
  lines.push('');
  if (input.mcpServers) {
    for (const [name, server] of Object.entries(input.mcpServers)) {
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args && server.args.length > 0) {
        lines.push(`args = ${tomlStringArray(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(server.env)) {
          lines.push(`${k} = ${tomlString(v)}`);
        }
      }
      lines.push('');
    }
  }
  writeFileSync(path.join(codexHome, 'config.toml'), lines.join('\n'), 'utf8');

  // System prompt: codex has no --append-system-prompt; it loads AGENTS.md from
  // CODEX_HOME as global instructions. Rewritten each spawn so updated wiki/pins
  // context is picked up.
  if (input.systemPrompt.length > 0) {
    writeFileSync(path.join(codexHome, 'AGENTS.md'), input.systemPrompt, 'utf8');
  }

  // argv: interactive TUI (no `exec`). Global options precede the optional
  // `resume <id>` subcommand and the positional seed prompt.
  const args: string[] = ['--dangerously-bypass-approvals-and-sandbox', '-C', input.cwd];
  if (input.model) args.push('--model', input.model);
  // Codex reasoning effort via config override; 'max' is claude-only (skip).
  if (input.reasoningEffort && input.reasoningEffort !== 'max') {
    args.push('-c', `model_reasoning_effort=${input.reasoningEffort}`);
  }
  if (input.resume) {
    args.push('resume', input.resume);
  }
  if (input.initialText && input.initialText.length > 0) {
    args.push(input.initialText);
  }

  return {
    args,
    codexHome,
    cleanup() {
      // The CODEX_HOME is stable (needed for resume) — removed only on session
      // deletion via removeCodexHome(), not on terminal teardown.
    },
  };
}
