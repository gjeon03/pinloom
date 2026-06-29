export const DEFAULT_BACKEND_PORT = 4748;
export const DEFAULT_FRONTEND_PORT = 4747;

// Global WS channel that mirrors run start/finish/error for every session, so
// one app-wide listener can raise "chat finished" notifications for sessions
// whose tab isn't currently open. Per-session detail still flows on
// `session:<id>`.
export const WS_RUNS_CHANNEL = 'runs';

export const PLAN_ITEM_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;

// Model new claude sessions default to. We use the `opus` ALIAS rather than a
// pinned version id or null: the CLI resolves `opus` to the newest Opus it
// knows (verified: `--model opus` → claude-opus-4-8), so the default tracks the
// latest model automatically with NO per-release bumping. This also sidesteps
// the bundled/PATH `claude` binary's stale built-in default (it resolved a bare
// run to Opus 4.7 while `--model opus` and the user's terminal give 4.8). Users
// can still pin a specific version or pick "CLI default" per session.
export const DEFAULT_CLAUDE_MODEL = 'opus';
