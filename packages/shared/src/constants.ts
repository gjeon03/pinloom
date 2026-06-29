export const DEFAULT_BACKEND_PORT = 4748;
export const DEFAULT_FRONTEND_PORT = 4747;

// Global WS channel that mirrors run start/finish/error for every session, so
// one app-wide listener can raise "chat finished" notifications for sessions
// whose tab isn't currently open. Per-session detail still flows on
// `session:<id>`.
export const WS_RUNS_CHANNEL = 'runs';

export const PLAN_ITEM_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;

// Model new claude sessions default to. We pin the latest Opus explicitly
// rather than leaving it null ("CLI default"), because the bundled/PATH-resolved
// `claude` binary's built-in default can lag behind (it was resolving to Opus
// 4.7 while the user's interactive terminal defaulted to 4.8). Pinning the
// latest keeps pinloom's default in step with the newest model; bump on release.
// The user can still pick "CLI default" or any other model per session.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
