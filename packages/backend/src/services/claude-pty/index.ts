// PTY-driven Claude transport. Drives an interactive `claude` REPL so usage
// bills against the interactive (weekly) bucket rather than the separate
// Agent-SDK credit bucket (2026-06-15 billing split). See
// docs/billing/dual-bucket-plan.md.
//
// Dormant by design: exported + tested but NOT registered in agents/index.ts.
// Wiring it as a live transport is the post-6/15 step (gated on bucket
// experiments). Until then this is zero-regression to the SDK path.

import { createClaudePtyAdapter } from './claude-pty-adapter.js';
import { nodeClaudeSessionFactory } from './node-session.js';

export { createClaudePtyAdapter } from './claude-pty-adapter.js';
export { nodeClaudeSessionFactory, shutdownClaudePty } from './node-session.js';
export type { ClaudeSession, ClaudeSessionFactory, ClaudeSessionSpec } from './session.js';

/** Production adapter: PTY orchestration wired to the real node-pty factory. */
export const claudePtyAdapter = createClaudePtyAdapter(nodeClaudeSessionFactory);
