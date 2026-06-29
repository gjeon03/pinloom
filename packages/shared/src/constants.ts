export const DEFAULT_BACKEND_PORT = 4748;
export const DEFAULT_FRONTEND_PORT = 4747;

// Global WS channel that mirrors run start/finish/error for every session, so
// one app-wide listener can raise "chat finished" notifications for sessions
// whose tab isn't currently open. Per-session detail still flows on
// `session:<id>`.
export const WS_RUNS_CHANNEL = 'runs';

export const PLAN_ITEM_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;

// Model new claude sessions default to. A pinned version id, NOT null and NOT
// the `opus` alias:
//   - null ("CLI default") → the bundled/PATH claude binary's stale built-in
//     default, which resolved to Opus 4.7.
//   - `opus` alias → resolves to 4.8 in `--print`, but pinloom's INTERACTIVE
//     TUI resolves the same alias to 4.7 (verified empirically). Only an
//     explicit version id forces 4.8 in the TUI.
// So we pin the explicit latest. Downside: bump on each Opus release (a future
// app-settings `default_claude_model` would let the user change it without a
// rebuild — see PR #163 discussion). Users can still pick any model per session.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
