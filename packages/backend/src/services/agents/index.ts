import type { AgentKind } from '@pinloom/shared';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';
import type { AgentAdapter } from './types.js';

export type ClaudeTransport = 'sdk' | 'pty' | 'terminal';

/**
 * The configured claude transport (PINLOOM_CLAUDE_TRANSPORT env), default 'sdk':
 *  - 'sdk':      Agent SDK (streaming, structured chat). Default, zero regression.
 *  - 'pty':      PTY-driven interactive `claude` as a structured adapter
 *                (interactive bucket, non-streaming). See docs/billing/.
 *  - 'terminal': interactive `claude` rendered live in an xterm.js terminal
 *                (interactive bucket, streaming). See docs/terminal-chat-mode-plan.md.
 * This is the global DEFAULT; a session pins the value it was created under in
 * sessions.transport so flipping the env mid-life doesn't strand a session.
 * Read per call so it can be flipped via env without a rebuild.
 */
export function claudeTransport(): ClaudeTransport {
  const v = process.env.PINLOOM_CLAUDE_TRANSPORT;
  return v === 'pty' || v === 'terminal' ? v : 'sdk';
}

export function claudeTransportIsPty(): boolean {
  return claudeTransport() === 'pty';
}

export function getAgentAdapter(agent: AgentKind): AgentAdapter {
  switch (agent) {
    case 'codex':
      return codexAdapter;
    case 'claude':
    default:
      return claudeTransportIsPty() ? claudePtyAdapter : claudeAdapter;
  }
}

export type { AgentAdapter, AgentRun, AgentRunArgs, NormalizedEvent } from './types.js';
