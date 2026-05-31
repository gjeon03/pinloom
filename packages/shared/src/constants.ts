export const DEFAULT_BACKEND_PORT = 4748;
export const DEFAULT_FRONTEND_PORT = 4747;

// Global WS channel that mirrors run start/finish/error for every session, so
// one app-wide listener can raise "chat finished" notifications for sessions
// whose tab isn't currently open. Per-session detail still flows on
// `session:<id>`.
export const WS_RUNS_CHANNEL = 'runs';

export const PLAN_ITEM_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;
