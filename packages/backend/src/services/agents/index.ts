import type { AgentKind } from '@pinloom/shared';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';
import { getSetting } from '../app-settings.js';
import type { AgentAdapter } from './types.js';

export type ClaudeTransport = 'sdk' | 'pty' | 'terminal';

/** app_settings key for the user-managed default transport. */
export const DEFAULT_TRANSPORT_KEY = 'default_claude_transport';

/**
 * The default claude transport for NEW sessions:
 *  - 'sdk':      Agent SDK (streaming, structured chat). Default, zero regression.
 *  - 'pty':      PTY-driven interactive `claude` as a structured adapter
 *                (interactive bucket, non-streaming). See docs/billing/.
 *  - 'terminal': interactive `claude` rendered live in an xterm.js terminal
 *                (interactive bucket, streaming). See docs/terminal-chat-mode-plan.md.
 *
 * Resolution order: the user-managed app setting (Settings UI) wins, then the
 * PINLOOM_CLAUDE_TRANSPORT env (dev/ops override), then 'sdk'. A session pins
 * the value it was created under in sessions.transport, so changing the default
 * later doesn't strand an existing session. Read per call (one indexed PK
 * lookup) so a change applies without a restart.
 */
export function claudeTransport(): ClaudeTransport {
  const s = getSetting(DEFAULT_TRANSPORT_KEY);
  if (s === 'sdk' || s === 'pty' || s === 'terminal') return s;
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
