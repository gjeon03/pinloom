// Transport seam for the PTY-driven Claude adapter. A `ClaudeSession` is one
// live interactive `claude` REPL: you start it once, run N turns through it
// (each turn = inject a prompt, wait for the Stop hook, read that turn's
// transcript lines), then dispose. Two implementations:
//
//   - node-session.ts  — real: node-pty + a localhost Stop-hook server + fs
//                         transcript reads. The fragile, version-sensitive
//                         part; validated by the user-run integration test.
//   - the mock in claude-pty-adapter.test.ts — deterministic, no pty/http/fs,
//                         so the orchestration logic is CI-tested in isolation.
//
// The adapter itself (claude-pty-adapter.ts) only orchestrates the multi-turn
// loop + event mapping + abort/close, and is agnostic to which factory it got.

import type { JsonlLine } from '../claude-jsonl/index.js';
import type { UserPrompt } from '../agents/message-stream.js';
import type { McpStdioServerConfig } from '../agents/types.js';

export interface ClaudeSessionSpec {
  cwd: string;
  /** Full system prompt (static + dynamic concatenated — TUI has no cache split). */
  systemPrompt: string;
  model?: string;
  /** Prior sessionId to `--resume`; null = fresh session. */
  resume?: string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  mcpServers?: Record<string, McpStdioServerConfig>;
}

export interface ClaudeSession {
  /** The Claude session id (transcript file stem). Known once started. */
  sessionId(): string | null;
  /**
   * Inject one prompt, block until that turn's Stop hook fires, and return
   * exactly the transcript lines that turn produced (descendants of the
   * injected prompt — sidechain/noise/synthetic already dropped).
   * Rejects on abort or turn timeout.
   */
  runTurn(prompt: UserPrompt, signal: AbortSignal): Promise<JsonlLine[]>;
  /** Kill the REPL process group and clean up temp settings/dirs. Idempotent. */
  dispose(): Promise<void>;
}

export interface ClaudeSessionFactory {
  start(spec: ClaudeSessionSpec): Promise<ClaudeSession>;
}
