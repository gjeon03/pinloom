# Codex Native Compaction UX Design

**Date:** 2026-08-12
**Status:** Proposed for implementation
**Scope:** Pinloom Codex terminal context status and rollover UX

## Objective

Keep long Codex terminal sessions on Codex's native automatic compaction path while making context pressure understandable. Treat Pinloom's linked fresh-session rollover as an explicit fallback, not the default action.

## Success criteria

- Pinloom does not override Codex's model-owned automatic compaction threshold, threshold scope, or compaction prompt.
- Pinloom never injects `/compact` into a PTY automatically.
- Normal context state explains that Codex manages context automatically and does not present rollover as the primary action.
- Rollover is exposed only when current pressure is critical or the most recently observed post-compaction baseline remains high.
- A collapsed terminal side panel still exposes elevated or critical context pressure through an accessible indicator.
- Existing context hydration, WebSocket updates, checkpoint generation, linked-session creation, focus management, and error isolation remain intact.

## Decision

Use a native-first policy:

1. Leave `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope`, and `compact_prompt` unset in Pinloom's generated Codex configuration.
2. Continue observing canonical Codex compaction and token events from the incremental rollout reader.
3. Explain native automatic context management in the UI.
4. Offer the existing user-confirmed rollover only as a fallback.

This design deliberately avoids fixed token limits. Codex models expose different effective context windows, and a universal number would compact some models prematurely while allowing others to grow too far. It also avoids a custom `compact_prompt`: that setting replaces the native prompt rather than extending it and may bypass future model- or version-specific improvements. Automatic `/compact` injection is excluded because it can race with human input, active turns, dispatch locks, native compaction, terminal redraws, and process restarts.

## Context policy

Pinloom derives presentation policy from the existing `CodexContextState`; no new API or database field is required.

### Telemetry validity

Presentation treats current telemetry as valid only when all of the following hold:

- `available === true`;
- `inputTokens` is a finite, non-negative safe integer;
- `contextWindowTokens` is a finite, positive safe integer.

`available === false` always wins over populated numeric fields. `cachedInputTokens` does not participate in guidance. A post-compaction baseline is valid only when current telemetry is valid, `observedCompactions` is a positive safe integer, and `postCompactionInputTokens` is a finite, non-negative safe integer. Inconsistent partial states, including a baseline with zero observed compactions or a valid-looking baseline while current telemetry is unavailable, are ignored and cannot expose rollover.

### Current pressure

`currentPercentage = inputTokens / contextWindowTokens * 100`

- unavailable: telemetry is missing or invalid
- normal: below 75%
- elevated: 75% or higher and below 90%
- critical: 90% or higher

### Post-compaction pressure

When both values are valid:

`postCompactionPercentage = postCompactionInputTokens / contextWindowTokens * 100`

A post-compaction baseline of 75% or higher means the most recently observed compaction left little headroom. This is an evidence-based rollover recommendation even if current pressure has not yet reached 90% again.

Guidance precedence is exact: a valid post-compaction percentage at or above 75% produces `recommended`; otherwise a valid critical current severity produces `fallback`; every other state produces `auto`.

### Guidance matrix

| State | Primary guidance | Rollover treatment |
|---|---|---|
| unavailable | Context usage is not available yet; Codex manages context automatically | hidden |
| normal | Codex manages context automatically as the session grows | hidden |
| elevated, post-compaction baseline below 75% or unavailable | Usage is high; native automatic compaction remains the primary path | hidden |
| critical, post-compaction baseline below 75% or unavailable | Native compaction remains active; use a fresh thread if latency persists | visible fallback |
| any available current state with post-compaction baseline at or above 75% | The latest compaction left limited headroom | visible recommendation |

Rollover is never invoked automatically. If confirmation is already open or rollover is in flight, telemetry changes do not unmount the confirmation controls or move focus unexpectedly.

The current guidance is not latched after confirmation closes. On cancellation, focus returns to the rollover CTA if it is still eligible. If telemetry changed and the CTA is no longer eligible, focus moves to the context row section, which is a programmatically focusable stable target with an accessible label. This avoids retaining a stale fallback action solely for focus restoration.

## UI design

### Expanded context row

The existing Codex-only context row remains in the terminal side panel and continues to show current token usage. Its copy changes from raw instrumentation toward actionable status:

- Always state that Codex handles automatic compaction when telemetry is normal or not yet available.
- Show observed automatic compaction count only after at least one compaction has been observed.
- Show the latest post-compaction baseline when available.
- Hide the rollover action in unavailable, normal, and ordinary elevated states.
- Label the visible fallback action `Switch to a fresh thread` rather than `Continue fresh`.
- Distinguish `fallback` and `recommended` with text in addition to color.
- Preserve the existing inline confirmation explaining the final visible checkpoint turn and source-history preservation.

The existing checkpoint and linked-session backend behavior is unchanged.

### Collapsed panel indicator

Do not auto-expand the side panel. When current pressure is elevated or critical, add a compact visual indicator inside the existing collapsed terminal rail expand control. The indicator is non-interactive decoration, not a second button.

- The indicator uses the existing semantic tool/error colors.
- The existing expand control's accessible label and tooltip include a localized textual state such as `Codex context high` or `Codex context critical`; the decorative indicator is hidden from assistive technology and color is not the only signal.
- Normal and unavailable states do not add visual noise.
- The indicator opens the existing side panel; it does not trigger compaction or rollover.

### Accessibility

- Keep current confirmation autofocus, cancel focus restoration, `aria-busy`, polite progress status, and assertive error alert behavior.
- Add visible `focus-visible` treatment to all context action buttons.
- Give rollover actions a minimum 32 px height and visible `focus-visible` treatment instead of the existing 10 px text-only target.
- Announce a change in guidance category through a polite status region, but do not announce every token-percentage update.
- Keep confirmation mounted while it is open or an operation is in progress.

## Component boundaries

### Pure context policy helpers

`packages/frontend/src/components/codex-context.ts` owns:

- safe current percentage calculation;
- safe post-compaction percentage calculation;
- severity derivation;
- guidance derivation: `auto`, `fallback`, or `recommended`;
- rollover visibility and recommendation semantics;
- confirmation focus-target transitions.

These helpers remain framework-independent and receive exhaustive boundary tests. The focus-target helper can return the stable context row as well as the confirmation and rollover buttons.

### Expanded row

`packages/frontend/src/components/CodexContextRow.tsx` renders the policy returned by the helpers. It owns presentation and the existing rollover request lifecycle, but it does not reinterpret numeric thresholds.

### Side-panel rail

`packages/frontend/src/components/TerminalSidePanel.tsx` consumes the same severity helper for the collapsed indicator. It does not add another telemetry request or WebSocket.

### Localization

`packages/frontend/src/i18n/strings.ts` supplies complete English, Korean, and Chinese strings for native auto-management guidance, fallback/recommended explanations, accessible rail labels, and revised rollover actions.

## Error handling

- Missing or malformed current telemetry produces unavailable guidance and never exposes rollover. An invalid or inconsistent auxiliary post-compaction baseline is ignored only for the recommendation calculation; it does not invalidate otherwise valid current telemetry or suppress a critical fallback.
- Context GET failures remain isolated from rollover action failures.
- A later WebSocket event or reconnect hydration clears only the recovered load error, following the existing reducer contract.
- Rollover failures remain attached to the source panel and never open a destination tab.
- No telemetry condition starts a checkpoint operation without explicit user activation and confirmation.

## Testing and verification

### Pure policy tests

Add cases for:

- unavailable and malformed telemetry;
- 74.9%, 75%, 89.9%, and 90% current-pressure boundaries;
- 74.9% and 75% post-compaction boundaries;
- current usage above the reported window;
- ordinary elevated state hiding rollover;
- critical fallback visibility;
- high post-compaction baseline producing a recommendation;
- confirmation visibility and focus-target selection after telemetry returns to normal.

Automated unit tests own numeric validity, `available` precedence, inconsistent baseline rejection, percentage boundaries, guidance precedence, rollover visibility, and pure focus-target selection. They do not claim to verify DOM mounting or actual browser focus.

### Automated browser and integration checks

- Existing hydration and WebSocket tests remain green.
- Existing duplicate-submit, failure retry, focus restoration, and one-time handoff behavior remain green.
- Playwright smoke coverage verifies that normal guidance hides the rollover CTA, an eligible fallback keeps its confirmation mounted while telemetry changes, cancellation focuses the CTA when still eligible and the stable context row otherwise, and the collapsed expand control exposes the correct accessible name for elevated and critical states.
- No new frontend testing dependency is required for this focused change. Pure selectors receive unit coverage and the existing Playwright infrastructure verifies rendered behavior.

### Manual visual QA

- Inspect expanded normal, elevated, fallback, and recommended states in both light and dark themes.
- Inspect collapsed elevated and critical indicators at supported dock positions.
- Confirm focus rings are visible and the minimum action height does not disrupt the compact side-panel layout.

### Repository verification

Run frontend tests, backend tests affected by the shared working tree, repository typecheck, lint, production build, smoke tests, and `git diff --check` before deployment.

## Rollout and rollback

This change has no migration, dependency, API, or Codex configuration change. Rollback is limited to reverting frontend policy, copy, and indicator rendering. Existing native automatic compaction and the rollover backend continue to operate independently.

## Deferred work

- A user-selectable advanced compaction preset is deferred until multiple Codex models and versions show measurable benefit over native defaults.
- A Pinloom compaction-prompt experiment is deferred until it can be evaluated against native remote and local compaction paths.
- Explicit user-triggered `/compact` integration is deferred until Codex exposes a stable programmatic contract that avoids PTY command injection.
