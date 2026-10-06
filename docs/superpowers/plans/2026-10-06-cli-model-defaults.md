# CLI Model Defaults Implementation Plan

**Goal:** Follow each local CLI's configured model unless the user explicitly selects one.

**Architecture:** Keep `null` as the session default. Remove versioned UI presets and background-job fallbacks. Preserve model settings when creating isolated Codex homes, while leaving explicit session overrides on CLI arguments.

**Tech Stack:** TypeScript, React, Claude Agent SDK, pnpm, Vitest.

## Scope and decisions

- Use CLI defaults instead of replacing old model IDs with another fixed version.
- Keep existing explicit session and administrator choices; do not migrate live data.
- Keep historical transcript model IDs and test fixtures: they record actual responses, not execution defaults.
- No new dependencies or changes to the user's global configuration. Commit and push are authorized by the user's follow-up.

## Implementation

- [x] Make shared UI presets default to `null`; expose CLI default in hidden-picker settings and use CLI default plus custom model input for both agents.
- [x] Remove model fallbacks in recap, handover, wiki analysis/sync/gardening and timeline distillation; load the CLI settings sources for SDK calls.
- [x] Add model-setting inheritance in `codex-user-config.ts` and use it before table declarations in terminal and SDK generated configurations.
- [x] Verify defaults, explicit overrides, missing configuration, configuration refresh, and existing MCP conflict handling.
- [x] Run typecheck, relevant tests, the full existing test suites, and the build. Report any missing lint command.
- [x] Deploy with the existing `pnpm --filter @pinloom/desktop run deploy:app` script and verify the installed app starts and serves the new bundle (authorized by the user's follow-up).

## Risks and validation

Background jobs will use the configured CLI model, so their cost and latency follow that choice. Existing pinned sessions remain pinned. Configuration inheritance must retain top-level TOML scope and omit unrelated plugin paths. Use temporary test homes and databases; never mutate the live data store.

## Verification results

- Node 24.15.0 (the repository-pinned runtime): `pnpm typecheck` passed.
- `pnpm test`: 799 backend tests and 79 frontend tests passed; 7 opt-in integration tests skipped.
- No lint script is configured; `git diff --check` passed.
- Independent review found a custom-provider inline/dotted TOML edge case; fixed and covered by regression tests. Reviewer verified both source and generated configurations with the installed Codex CLI successfully.
- Production build and staged Electron native-module checks passed. Deployment uses `NODE_USE_SYSTEM_CA=1` to trust the operating system's certificate authorities during package staging.
- `/Applications/pinloom.app` was installed and relaunched. The sidecar's `/api/ping` returned `{"ok":true}` and served the new frontend asset. Installed backend files matched the built files by SHA-256.
- Ego browser verified the deployed settings UI exposes `CLI default` and retains the stored explicit model option without changing the user's settings.
