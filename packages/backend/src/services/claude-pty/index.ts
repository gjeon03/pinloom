// PTY-driven Claude transport. Drives an interactive `claude` REPL so usage
// bills against the interactive (weekly) bucket rather than the separate
// Agent-SDK credit bucket (2026-06-15 billing split). See
// docs/billing/dual-bucket-plan.md.
//
// The SDK adapter remains the default; this transport is opt-in via
// PINLOOM_CLAUDE_TRANSPORT=pty. Terminal-chat mode (in progress) reuses the
// Stop-hook server, launch spec, and transcript parser from here.

import { createClaudePtyAdapter } from './claude-pty-adapter.js';
import { nodeClaudeSessionFactory } from './node-session.js';

export { createClaudePtyAdapter } from './claude-pty-adapter.js';
export { nodeClaudeSessionFactory, shutdownClaudePty } from './node-session.js';
export type { ClaudeSession, ClaudeSessionFactory, ClaudeSessionSpec } from './session.js';
export { startStopHookServer } from './stop-hook-server.js';
export type { StopHookServer, StopHookPayload } from './stop-hook-server.js';

/** Production adapter: PTY orchestration wired to the real node-pty factory. */
export const claudePtyAdapter = createClaudePtyAdapter(nodeClaudeSessionFactory);
