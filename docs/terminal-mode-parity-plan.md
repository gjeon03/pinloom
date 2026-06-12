# Terminal-mode parity plan

Bring the terminal-chat transport up to useful parity with the structured (SDK)
chat, adapted to the "human types into a live claude TUI" form. Driven by a
3-agent gap analysis (2026-06-11).

## Hard invariant (non-negotiable)

**The SDK / structured path must not change in any observable way.** Every change
is either:
- inside a component that is ONLY rendered when `transport === 'terminal' && agent === 'claude'`, or
- a new, additive, backward-compatible prop on a SHARED component (e.g. `PinnedPanel`) that defaults to today's behavior, or
- a render-branch guard that adds a `transport === 'terminal'` condition without altering the `else` (structured) branch.

Explicitly DO NOT touch: `ChatView`, `ModelPicker`, `EffortPicker`, the runner
SDK streaming path, queue, image upload, or the structured render branch. After
each phase, regression-check that a structured session looks/behaves identically.

## What the gap analysis found (baseline)

- Pins **already work** for terminal sessions: `pins` loads via SWR for any
  active session (`ProjectPage` ~316-330), and the left `PinnedPanel` renders
  transport-agnostically (`ProjectPage` ~614-628) with the full feature set
  (title edit, expand/`FocusedPinView`, raw toggle, copy, download, send-pin,
  handoff, ZIP). `buildPinsContext` injects pins into the terminal launch prompt.
  → The gap is **discoverability + duplication**, not capability: my
  `TerminalSidePanel` added a *second*, basic pin UI on the right.
- Wiki is **globally reachable** (`/wiki`, sidebar, `buildWikiContext` already in
  `buildSessionLaunchInput`). The only missing affordance vs ChatView is the
  **"sync this session to wiki"** button (`ChatView` ~946-959 → `api.syncWiki`).
- Input-side features (model/effort/queue/image/@mention/shell) are handled by
  the native TUI (`/model`, `/effort`, paste, `!`) → intentionally skipped.

## Target terminal layout

```
[ left: hidden for terminal ]  [ center: AgentTerminal (live TUI) ]  [ right: TerminalSidePanel ]
```

`TerminalSidePanel` becomes a tabbed right rail — the chrome ChatView's
surroundings give structured mode, minus the input box (the TUI is the input):

- **History** — captured turns (today's list) + quick pin toggle + per-message
  expand/copy.
- **Pins** — the FULL pin manager, by reusing the existing `PinnedPanel`
  component (zero new pin logic; title edit, expand, send, handoff, ZIP).
- **Wiki** — "Sync this session to wiki" + this project's relevant pages with
  links into `/wiki/:filename`.

The left `PinnedPanel` is hidden for terminal sessions (it now lives in the right
rail's Pins tab) — a one-line guard that leaves the structured branch untouched.

## Phases

### Phase 1 — Tabbed right rail + reuse PinnedPanel for pins
- [ ] 1.1 `TerminalSidePanel` accepts pin props (`pins`, `onPinChange`,
  `projectName`, `onHandoff`, `onSendPin`) + `projectId`/`projectSlug`, passed
  from `ProjectPage`'s terminal branch (all already in scope there).
- [ ] 1.2 Add a tab bar: `History | Pins | Wiki` (persist active tab in
  localStorage per session). History = existing list. Pins = `<PinnedPanel>`
  reused verbatim. Wiki = Phase 2.
- [ ] 1.3 Hide the left `PinnedPanel` when the active session is terminal-claude
  (guard the existing left condition only; structured unaffected).
- [ ] 1.4 Pin count badge on the Pins tab; History keeps its quick pin toggle.
- [ ] Verify: typecheck + build; multi-agent review (gating-invariant audit +
  code review); Playwright on dev:terminal (pins show, expand works) AND a
  structured session looks unchanged. Commit.

### Phase 2 — Wiki tab (sync + access)
- [ ] 2.1 Wiki tab: "Sync this session to wiki" button → `api.syncWiki(sessionId)`
  with in-flight state + notification (mirror ChatView ~892-911, no ChatView edit).
- [ ] 2.2 List this project's relevant wiki pages (`api.wikiOverview()` filtered
  by `applies_to` ∋ projectSlug or `global`) with links to `/wiki/:filename` and
  an "open wiki" link to `/wiki`.
- [ ] Verify: typecheck + build; agent review; Playwright (sync button fires,
  pages list renders). Commit.

### Phase 3 — History polish
- [ ] 3.1 Per-message expand/detail (reuse a pin-card-style expanded view) +
  copy-markdown button (reuse `MessageActions` `CopyMarkdownButton`).
- [ ] 3.2 Tool rows: nicer summary (reuse `summarizeToolCall` output already
  stored) — optional, low risk.
- [ ] 3.3 "Jump to latest" affordance already exists via sticky-bottom; add a
  small "N new" pill only if cheap.
- [ ] Verify: agent review + Playwright. Commit.

### Phase 4 — Integration + regression hardening
- [ ] 4.1 Full Playwright pass on dev:terminal: tabs, pins lifecycle, wiki sync,
  exit overlay still works.
- [ ] 4.2 **SDK-path regression**: open a structured (sdk) session in the same
  build — confirm left PinnedPanel, ChatView, model/effort, queue all identical.
- [ ] 4.3 Multi-agent final review (security/correctness/gating). Address findings.
- [ ] 4.4 Update CLAUDE.md / this doc status. Commit.

## Verification protocol (per phase)
1. `pnpm typecheck` + relevant build.
2. Spawn ≥2 review agents: (a) **gating-invariant auditor** — diff each change,
   assert no structured/SDK path is altered; (b) **code reviewer** — correctness,
   prop wiring, dedup. Address blocking findings before commit.
3. Playwright on the running dev:terminal instance for the terminal behavior, and
   a quick structured-session check for no-regression.
4. Commit per phase (English messages, project convention).

## Status
- [x] Phase 1 — tabbed History|Pins rail (reuse PinnedPanel), left rail hidden for terminal. Verified (2 agents + Playwright). Commit 69cc789.
- [x] Phase 2 — Wiki tab (sync this session + relevant pages + open-wiki). Verified (2 agents + Playwright). Commit 585d340.
- [x] Phase 3 — History polish (per-row Copy + Expand). Verified (agent + Playwright). Commit f5f58d7.
- [x] Phase 4 — Final review (gating PASS, security clean, integration COMMENT). Fixed the 2 MAJORs: History stays mounted (CSS-hidden) so scroll/refs survive tab switches; sticky-effect gated to the History tab. Verified DOM-persistence via Playwright.

### Known follow-ups (non-blocking, from final review)
- `api.listMessages` loads all messages into the panel (mirrors ChatView) — fine for now; server-side pagination is a future ticket for very long sessions.
- `projectSlug` duplicates the backend wiki-slug (collision suffix skipped) — display-only; a shared helper + test would harden it.
- Tool rows count against the History window budget — could exclude them later.
