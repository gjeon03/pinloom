import type { AgentKind } from '@pinloom/shared';
import { claudeAdapter } from './claude-adapter.js';
import { claudeRemoteAdapter } from './claude-remote-adapter.js';
import { codexAdapter } from './codex-adapter.js';
import type { AgentAdapter } from './types.js';

// `PINLOOM_REMOTE_CONTROL=1` routes every Claude session through the
// remote-control adapter (bridges to claude.ai). The local turn-by-turn
// adapter stays the default — flipping the env var has no effect on
// Codex sessions and the existing adapter is otherwise untouched.
//
// Read at boot so the value can't drift between turns of the same
// session (a session must pick exactly one adapter for its lifetime).
const REMOTE_CONTROL_ENABLED = process.env.PINLOOM_REMOTE_CONTROL === '1';

// `sessionId` is currently unused — env-var-as-global is the activation
// signal in PR 1. The parameter is in the signature now so PR 3 can swap
// to a per-session SQLite flag without touching every call site at the
// same time as adding the toggle column. Snapshot the decision in
// `SessionContext` at session load to keep adapter choice stable for a
// session's lifetime.
export function getAgentAdapter(
  agent: AgentKind,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _sessionId?: string,
): AgentAdapter {
  switch (agent) {
    case 'codex':
      return codexAdapter;
    case 'claude':
    default:
      return REMOTE_CONTROL_ENABLED ? claudeRemoteAdapter : claudeAdapter;
  }
}

export type { AgentAdapter, AgentRun, AgentRunArgs, NormalizedEvent } from './types.js';
