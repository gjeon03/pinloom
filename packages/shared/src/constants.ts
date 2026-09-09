export const DEFAULT_BACKEND_PORT = 4748;
export const DEFAULT_FRONTEND_PORT = 4747;

// Global WS channel that mirrors run start/finish/error for every session, so
// one app-wide listener can raise "chat finished" notifications for sessions
// whose tab isn't currently open. Per-session detail still flows on
// `session:<id>`.
export const WS_RUNS_CHANNEL = 'runs';

export const PLAN_ITEM_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;

// Concrete model used when the model picker is PINNED — the `simple` preset
// hides the picker, and an admin can fix it from settings. It is NOT the
// default for new sessions: those store `null` and follow whatever the local
// Claude Code CLI is configured for (see the sessions route).
//
// History worth keeping: this used to be the new-session default, pinned to an
// explicit version id because `null` and the `opus` alias both resolved a
// generation behind in the interactive TUI. That is no longer true — verified
// on CLI v2.1.266, launching with no `--model` boots "Opus 5 (1M context) with
// xhigh effort". The pin outlived its reason and quietly held every new session
// a generation back, so following the CLI is both correct and self-maintaining.
// Only this pinned-picker value still needs a bump on release.
export const PINNED_CLAUDE_MODEL = 'claude-opus-5';
