# Contributing to pinloom

Thanks for your interest. pinloom is a small, local-first project — keep PRs
focused and the bar is "does it ship something useful without breaking the
local-only model or the per-project Wiki + Sessions contract?"

## Setup

```bash
pnpm install
pnpm dev             # backend (4748) + frontend (4747) with HMR
```

You'll need at least one agent CLI installed and authenticated locally —
either [Claude Code](https://docs.claude.com/en/docs/claude-code) or
[Codex CLI](https://github.com/openai/codex). pinloom inherits their auth;
no API keys live in pinloom's config.

## Before you open a PR

```bash
pnpm typecheck       # tsc -b
pnpm test            # backend vitest suite
pnpm build           # shared → backend → frontend
```

CI runs all of the above. PRs that fail CI won't be reviewed until they're
green.

## Conventions

- **Language**: code, comments, commit messages, and PR descriptions are in
  English. UI strings are in English by default.
- **TypeScript**: strict mode, ESM only, named exports.
- **Indent**: 2 spaces (JS/TS/JSON/YAML).
- **Commits**: `type: short description` (`feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`, `perf`). One logical change per commit when practical.
- **No `--no-verify`.** If a hook fails, fix the underlying issue.

## Design rules (please read before large changes)

The four rules in [`README.md`](./README.md#design-principles) are
load-bearing:

1. pinloom's SQLite owns conversation history (not `~/.claude/`).
2. The agent's memory lives on disk you control (Wiki + DB), exportable to GitHub or a file.
3. No auto-deletion.
4. Local-only — no auth, no cloud sync.

Changes that contradict these need a discussion in an issue first.

## Filing issues

- **Bugs**: include reproduction steps, the agent CLI you used, and relevant
  log output. pinloom logs to stdout when run with `pnpm dev` or `pnpm start`.
- **Feature requests**: describe the workflow you're trying to support, not
  just the UI you want. The local-only + Wiki-aware model often suggests a
  different shape than the obvious one.

## License

By contributing you agree your work is licensed under the project's MIT
license.
