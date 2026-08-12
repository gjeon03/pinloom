# Codex Native Compaction UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain Codex native automatic context management and expose fresh-thread rollover only as an evidence-based fallback.

**Architecture:** Extend the existing pure Codex context helpers with strict telemetry validity and one guidance selector. `CodexContextRow` renders that selector while retaining its checkpoint request lifecycle. `TerminalSidePanel` reuses severity for a noninteractive indicator inside the existing collapsed expand control; no new API, WebSocket, or persistence is introduced.

**Tech Stack:** TypeScript strict mode, React 19, Tailwind CSS v4 semantic tokens, Vitest, Playwright, pnpm.

## Global Constraints

- Leave `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope`, and `compact_prompt` unset.
- Never inject `/compact` and never trigger rollover from telemetry.
- Current telemetry is valid only with `available === true`, non-negative safe-integer input tokens, and a positive safe-integer context window.
- Post-compaction telemetry is valid only with valid current telemetry, positive safe-integer observed count, and non-negative safe-integer baseline.
- Exact guidance precedence: valid post-compaction percentage >=75 is `recommended`; otherwise current >=90% is `fallback`; otherwise `auto`.
- Current severity remains normal <75%, elevated >=75% and <90%, critical >=90%.
- Invalid auxiliary baseline does not invalidate valid current telemetry.
- Existing confirmation stays mounted while open/in flight. Cancellation returns to an eligible CTA or the stable context-row section if eligibility disappeared.
- Collapsed indicator is decorative inside the existing expand control; accessible state comes from the control's localized label/tooltip.
- No API, migration, dependency, or backend Codex configuration change.
- Preserve unrelated and pre-existing uncommitted changes. Do not commit in this shared dirty worktree.
- Code/comments are English and contain no issue/ticket numbers.

---

### Task 1: Strict context guidance policy

**Files:**
- Modify: `packages/frontend/src/components/codex-context.ts`
- Modify: `packages/frontend/src/components/codex-context.test.ts`

**Interfaces:**
- Produces `getCodexPostCompactionPercentage(context): number | null`.
- Produces `getCodexContextGuidance(context): 'auto' | 'fallback' | 'recommended'`.
- Extends focus target to `'confirm' | 'continue' | 'context' | null` and accepts whether the rollover CTA remains eligible after cancellation.

- [ ] **Step 1: Add RED validity and boundary tests**

  Cover unavailable, false `available`, null, negative, decimal, unsafe, NaN/infinite values; exact 74.9/75 and 89.9/90 current boundaries; exact 74.9/75 baseline boundaries; over-window values; zero compaction with populated baseline; unavailable current with populated baseline; invalid baseline with valid critical current.

- [ ] **Step 2: Add RED guidance/focus tests**

  Assert precedence `recommended > fallback > auto`, ordinary elevated hides rollover, critical exposes fallback, high baseline recommends even before current critical, and cancel returns `continue` only while eligible or `context` otherwise.

- [ ] **Step 3: Run focused RED test**

  Run `pnpm --filter @pinloom/frontend test -- src/components/codex-context.test.ts`. Expected: missing selectors/new focus contract failures only.

- [ ] **Step 4: Implement minimal pure policy**

  Use safe-integer validation and keep raw over-window percentages honest. Do not duplicate thresholds in components.

- [ ] **Step 5: Run focused GREEN**

  Run the focused test and frontend typecheck. Write RED/GREEN evidence to `.superpowers/sdd/2026-08-12-codex-native-compaction-ux/task-1-report.md`. Do not commit.

---

### Task 2: Native-first context row and collapsed severity indicator

**Files:**
- Modify: `packages/frontend/src/components/CodexContextRow.tsx`
- Modify: `packages/frontend/src/components/TerminalSidePanel.tsx`
- Modify: `packages/frontend/src/i18n/strings.ts`
- Modify: `packages/frontend/src/components/codex-context.test.ts`

**Interfaces:**
- `CodexContextRow` consumes only the pure guidance selector and existing rollover API.
- `TerminalSidePanel` consumes existing context state/severity and creates no additional request/subscription.

- [ ] **Step 1: Add RED presentation policy tests**

  Extend pure render-model tests so auto guidance has no CTA, fallback/recommended have distinct localized message keys and action emphasis, observed compaction text appears only above zero, and confirmation visibility remains latched while open/in flight.

- [ ] **Step 2: Implement localized native guidance**

  Add complete en/ko/zh strings for automatic context management, high usage, persistent post-compaction pressure, fallback/recommended labels, `Switch to a fresh thread`, stable context-section focus, and elevated/critical collapsed labels. Remove or stop using misleading always-primary rollover copy.

- [ ] **Step 3: Update `CodexContextRow`**

  Make the section programmatically focusable. Render status guidance without announcing percentage churn. Hide CTA for `auto`; render 32px+ accessible fallback/recommended actions with visible focus rings. Preserve confirmation and error behavior; on cancel focus CTA if eligible, otherwise focus the section.

- [ ] **Step 4: Add collapsed indicator**

  In the existing expand button, render an `aria-hidden` semantic dot only for elevated/critical. Extend that same button's localized `aria-label` and `title` with textual high/critical status. Do not add another button or auto-expand.

- [ ] **Step 5: Run GREEN verification**

  Run focused tests, all frontend tests, i18n check, frontend build/typecheck, repository typecheck, and `git diff --check`.

- [ ] **Step 6: Write task report**

  Record guidance matrix, focus behavior, accessibility decisions, localized keys, and GREEN evidence in `.superpowers/sdd/2026-08-12-codex-native-compaction-ux/task-2-report.md`. Do not commit.

---

### Task 3: Context UX browser verification

**Files:**
- Create: `e2e/codex-context-ux.spec.ts`
- Create: `e2e/codex-context-ux.config.ts`

- [ ] **Step 1: Create isolated fixtures**

  Seed Codex terminal sessions in a temporary DB and intercept context GET/WebSocket observations to render deterministic unavailable, normal, elevated, critical, and high-baseline states without a real Codex process.

- [ ] **Step 2: Add automated behavior checks**

  Verify auto state hides rollover, critical shows fallback, high baseline shows recommendation, confirmation remains when telemetry normalizes, cancel focuses CTA or stable section as appropriate, and collapsed elevated/critical controls expose correct accessible names.

- [ ] **Step 3: Verify themes and focus**

  Assert keyboard-visible focus and 32px minimum actions in automated checks; capture light/dark screenshots for manual comparison without pixel-perfect snapshot gating.

- [ ] **Step 4: Run isolated browser GREEN**

  Run `pnpm exec playwright test --config e2e/codex-context-ux.config.ts`, then write evidence to `.superpowers/sdd/2026-08-12-codex-native-compaction-ux/task-3-report.md`. Do not commit.

---

### Task 4: Context UX verification

**Files:**
- Modify only to fix regressions found by verification.

- [ ] **Step 1: Run repository verification**

  Run frontend and backend suites, repository typecheck, available lint/i18n checks, production build, isolated context UX browser tests, existing smoke test, and `git diff --check`.

- [ ] **Step 2: Manual visual QA**

  Inspect normal/elevated/fallback/recommended expanded states and collapsed indicators in light/dark themes and each dock position. Confirm rollover remains explicit and source-preserving.

- [ ] **Step 3: Write final report**

  Record automated/manual evidence and confirm the generated Codex config contains no compaction override in `.superpowers/sdd/2026-08-12-codex-native-compaction-ux/final-report.md`. Do not commit.
