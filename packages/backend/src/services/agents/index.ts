import type { AgentKind } from '@pinloom/shared';
import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import { claudePtyAdapter } from '../claude-pty/index.js';
import type { AgentAdapter } from './types.js';

/**
 * Opt-in: when PINLOOM_CLAUDE_TRANSPORT=pty, `claude` sessions are driven through
 * an interactive `claude` REPL over a PTY so their usage bills the interactive
 * (weekly) bucket instead of the separate Agent-SDK credit bucket (2026-06-15
 * billing split). The default stays the SDK adapter — zero regression. Read per
 * call so it can be flipped via env without code changes. See
 * docs/billing/dual-bucket-plan.md.
 */
export function claudeTransportIsPty(): boolean {
  return process.env.PINLOOM_CLAUDE_TRANSPORT === 'pty';
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
