# CLI Model Defaults Implementation Plan

**Goal:** Remove automatic version pins and reset all existing app model selections. Claude conversations use the CLI's runtime Default option; Codex inherits its CLI configuration. Explicit future custom selections remain available.

**Architecture:** Keep `null` as the session default. Remove versioned UI presets and background-job fallbacks. Preserve model settings when creating isolated Codex homes, while leaving explicit session overrides on CLI arguments.

**Tech Stack:** TypeScript, React, Claude Agent SDK, pnpm, Vitest.

## Scope and decisions

- Use CLI defaults instead of replacing old model IDs with another fixed version.
- Reset existing session and administrator model choices too, as clarified by the user. Back up the live database first; preserve message history and unrelated settings.
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

Background jobs will use the configured CLI model, so their cost and latency follow that choice. Configuration inheritance must retain top-level TOML scope and omit unrelated plugin paths. Tests use temporary homes and databases; the authorized live reset is a separate backed-up transaction.

## Verification results

- Node 24.15.0 (the repository-pinned runtime): `pnpm typecheck` passed.
- `pnpm test`: 799 backend tests and 79 frontend tests passed; 7 opt-in integration tests skipped.
- No lint script is configured; `git diff --check` passed.
- Independent review found a custom-provider inline/dotted TOML edge case; fixed and covered by regression tests. Reviewer verified both source and generated configurations with the installed Codex CLI successfully.
- Production build and staged Electron native-module checks passed. Deployment uses `NODE_USE_SYSTEM_CA=1` to trust the operating system's certificate authorities during package staging.
- `/Applications/pinloom.app` was installed and relaunched. The sidecar's `/api/ping` returned `{"ok":true}` and served the new frontend asset. Installed backend files matched the built files by SHA-256.
- Ego browser verified the deployed settings UI exposes `CLI default` and retains the stored explicit model option without changing the user's settings.

## Recovery after user verification

The initial rollout incorrectly preserved old session overrides. The reported terminal still launched with `--model claude-opus-4-8`. Its process also inherited `NO_COLOR=1` from the app launcher, suppressing all colors.

- Clear all existing session model overrides, queued-message model overrides, and the administrator's fixed model selection. Preserve historical message model IDs.
- Claude conversation launches explicitly select the CLI's special `default` value when no model is selected. Omitting the argument lets resumed transcripts restore their old model. This selects Claude's runtime account default, without hardcoding a version; custom selections still work.
- Load local settings alongside user and project settings for Claude PTYs.
- Give all PTYs `TERM=xterm-256color` and `COLORTERM=truecolor`; remove the parent's color suppression overrides.
- Live reset completed in one transaction after a SQLite backup: 44 session overrides cleared, zero queued overrides present, administrator model fixed value set to null. All 166,781 messages and 54,519 historical model values were unchanged.
- Follow-up verification: typecheck passed; 805 backend and 79 frontend tests passed (7 opt-in skipped). No lint scripts are configured; `pnpm -r --if-present lint` and `git diff --check` succeeded.
- Redeployed `/Applications/pinloom.app`; installed changed backend modules match build outputs by SHA-256. Health check passed.
- The reported Claude conversation resumed under the same native session ID with `--model default`, displayed `Opus 5.5`, and emitted 28 distinct ANSI foreground-color sequences. The child has `TERM=xterm-256color`, `COLORTERM=truecolor`, and no `NO_COLOR` or `FORCE_COLOR`.
- An existing Codex conversation resumed with `GPT-6-Astra default`, matching the current user CLI configuration. Both terminal screenshots show restored colors.
- Independent review reproduced another stale default: SDK 0.2.114 bundles Claude 2.1.114, whose Default resolved to Opus 4.7. Route all eight SDK query sites through a shared wrapper selecting the installed `claude` executable (or `PINLOOM_CLAUDE_BIN`) and runtime `default`, matching PTY launches.
- The real SDK initialization handshake through the wrapper returned Default `resolvedModel=claude-opus-5-5`; no prompt was submitted and session persistence was disabled. Explicit custom models and executable overrides remain supported.
- Final tests after the SDK correction: 806 backend plus 79 frontend passed, typecheck passed; independent follow-up review found no material issues.
