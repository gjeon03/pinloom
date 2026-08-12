# Agent Terminal Scroll Recovery Design

**Date:** 2026-08-12
**Status:** Proposed for implementation
**Scope:** Pinloom Claude/Codex terminal viewport behavior, with Codex-specific inline launch compatibility

## Objective

Make terminal sessions reliably reopen at the latest output and provide a Pinloom-owned `Jump to latest` control whenever the user scrolls away from the bottom. Give Codex an xterm-compatible normal scrollback buffer instead of relying on its alternate-screen TUI.

## Confirmed causes

1. `AgentTerminal` has no bottom-state tracking, `scrollToBottom()` normalization, or Pinloom scroll button. The similar control exists only in the SDK `ChatView`; a Claude terminal affordance is produced by Claude itself rather than shared Pinloom UI.
2. A hidden dock panel returns `null`, disposing xterm and its WebSocket. Returning to the session creates a new xterm and replays the last raw PTY bytes without normalizing the viewport after replay or later fits.
3. The agent-terminal WebSocket attaches the PTY at a hard-coded `120x40` before the client reports its real fitted grid. Replay, the resulting TUI redraw, client fit, font-ready fit, and late fit can interleave.
4. Pinloom's isolated Codex `CODEX_HOME` does not inherit the user's TUI settings, and Codex currently launches in alternate-screen mode. xterm's alternate buffer has no normal scrollback, so a bottom button cannot expose earlier output there.

## Decision

Use four bounded changes together:

1. Launch Pinloom-owned Codex terminals with `--no-alt-screen`, before the optional `resume` subcommand. This is Codex's stable CLI override for `tui.alternate_screen = "never"` and applies to both fresh and resumed sessions. Do not force `tui.raw_output_mode`; it changes Codex presentation and upstream xterm compatibility reports show it is not a complete substitute for Pinloom viewport control.
2. Include the xterm's fitted `cols` and `rows` in the initial agent-terminal WebSocket query. The backend validates positive integer bounds and uses them for the initial attach; missing or invalid values fall back to `120x40` for protocol compatibility.
3. Add a small framework-independent terminal scroll controller and a Pinloom-owned `Jump to latest` button to `AgentTerminal` for both Claude and Codex terminal transports.
4. Normalize a newly mounted or reconnected terminal to the bottom only after replay completes, and preserve bottom anchoring across subsequent fit/resize operations. Never force a user who intentionally scrolled upward back to the bottom when live output arrives.

This design keeps the existing hidden-panel unmount behavior. Keeping every xterm and WebSocket mounted would increase resource use and reintroduce known hidden-container fit problems. Replacing raw replay with a semantic terminal snapshot or rewriting Codex ANSI sequences is deferred because both are substantially larger compatibility projects.

## Launch behavior

`buildCodexLaunch()` appends `--no-alt-screen` to the global Codex arguments after the sandbox/cwd/model/config options and before `resume` or any positional seed prompt.

- Fresh: `codex [global options] --no-alt-screen [initial prompt]`
- Resume: `codex [global options] --no-alt-screen resume <native-session-id> [initial prompt]`

The flag is emitted exactly once. Claude terminal launch behavior is unchanged.

Pinloom targets the installed Codex CLI contract that already exposes this flag. A launch failure remains visible through the existing agent-terminal unavailable overlay; this change does not add silent retry without the flag because that would restore the broken alternate-screen behavior unpredictably.

## Initial grid handshake

After opening xterm, `AgentTerminal` attempts the first safe fit. The helper returns whether `fit.fit()` completed successfully. Only after a successful fit does it open:

`/ws/agent-terminal?session=<id>&cols=<term.cols>&rows=<term.rows>`

If the first fit throws because the container or font metrics are not measurable, the client omits both grid query parameters and opens the WebSocket immediately. It does not send xterm's constructor-default grid as if it were measured, and it does not delay connection waiting for layout. The backend then uses `120x40`; the existing open/font-ready/late-fit resize path corrects it when measurement becomes available.

The backend accepts decimal integer strings only:

- `cols`: 20 through 1000
- `rows`: 5 through 500
- either missing, malformed, non-integer, or out of range: use the existing default pair `120x40`

The pair is atomic: if either value is invalid, both defaults are used. Later `{t:'r', c, r}` resize messages remain authoritative and unchanged.

This prevents an avoidable initial `120x40 → actual grid` redraw for current clients while retaining compatibility with older clients and direct WebSocket tests.

## Replay protocol

Every successful agent-terminal attach sends exactly one initial replay frame before delivering later live output to the socket:

```json
{ "t": "o", "d": "<possibly empty snapshot>", "replay": true }
```

The server sends this frame even when the snapshot is empty. The frame itself is the attach-level replay declaration; no-replay inference from timing is allowed.

The route preserves output without a snapshot/listener gap:

1. Before calling `attach`, create a connection-local FIFO of output strings and pass an `onData` callback that buffers while `replayDelivered === false`.
2. The terminal service synchronously takes the snapshot and registers that callback, following the existing attach contract.
3. After `attach` resolves, send the mandatory replay frame.
4. Set `replayDelivered = true`, flush every buffered string as ordinary live output frames in FIFO order, then send later `onData` values directly.

JavaScript execution makes the flag transition and FIFO drain atomic with respect to terminal callbacks. The route clears the FIFO if attach fails or the socket closes. This ordering guarantees that bytes emitted after the snapshot are delivered exactly once after replay rather than being lost or overtaking it.

The client starts each connection in an unsettled state and settles it only from the replay frame's `term.write` completion callback. For an empty snapshot, the client still calls `term.write('', callback)`, so the same completion path is used.

The existing replay safety timeout has one responsibility: clear input suppression if xterm's write callback is delayed or lost. It does not mark the viewport settled and does not consume the exactly-once bottom settlement. If the timeout fires, input is re-enabled while the button remains hidden; a later write callback still performs the one final bottom settlement. Cleanup cancels the timer. A connection whose write callback never arrives remains visually unsettled but usable and does not guess at a final viewport.

## Scroll state contract

The pure controller consumes a terminal buffer snapshot:

```ts
interface TerminalViewportSnapshot {
  bufferType: 'normal' | 'alternate';
  viewportY: number;
  baseY: number;
}
```

It derives:

- normal buffer at bottom: `viewportY >= baseY`;
- normal buffer away from bottom: `viewportY < baseY`;
- alternate buffer: no Pinloom scrollback is available, so the button stays hidden;
- replaying or not yet settled: the button stays hidden.

`AgentTerminal` subscribes to `term.onScroll` and updates state from `term.buffer.active`. State is also recomputed after replay, fits, and a programmatic jump.

## Replay and resize ordering

The terminal starts in a `replaying`/unsettled state when the connection is created. The mandatory initial replay frame completes that state.

On the replay `term.write` callback:

1. clear the replay guard;
2. set the follow-bottom intent;
3. call `term.scrollToBottom()`;
4. recompute bottom state;
5. allow the button to render.

The replay guard retains the existing hard timeout so xterm query responses cannot permanently disable input. Timeout completion only releases input suppression; viewport settlement still belongs to the replay write callback.

Every fit captures whether bottom-follow intent was active before fitting. If active, it calls `scrollToBottom()` after the fit and recomputes state. If the user has scrolled upward, fit does not change their viewport. `term.onScroll` is the authority that clears or restores follow-bottom intent after user and programmatic scrolls.

Live terminal output does not directly call `scrollToBottom()`. xterm may naturally follow output while already at bottom, but new output must not pull a user away from older text they are reading. After every terminal write callback, state is recomputed so a normal/alternate buffer transition cannot leave a stale button; only the mandatory initial replay callback performs forced bottom settlement.

## Jump-to-latest control

Render a button only when all conditions hold:

- terminal status is open;
- replay is settled;
- active buffer is normal;
- viewport is away from the bottom.

The control:

- is positioned at the bottom center above the TUI composer area;
- uses the existing semantic surface/border/accent tokens and an `ArrowDown` icon;
- has localized visible text or tooltip and `aria-label` `Jump to latest`;
- has at least a 32 px hit target and visible `focus-visible` styling;
- calls `term.scrollToBottom()`, restores follow-bottom intent, recomputes state, and returns focus to the terminal.

The shared `AgentTerminal` control is available to both Claude and Codex terminal sessions. No agent-specific frontend condition is added.

## Error and edge behavior

- Malformed WebSocket grid query values never reach node-pty; the backend uses defaults.
- A replay callback/timeout race releases input at most once and settles the viewport exactly once from the callback; cleanup clears all timers.
- A reconnect or explicit terminal restart uses the same initial-grid and replay settlement path.
- Alternate buffer mode hides the button instead of presenting an action that cannot reveal scrollback. The Codex launch change prevents this for newly spawned Pinloom Codex sessions; Claude retains its native buffer behavior.
- Raw replay may still begin inside an ANSI sequence because the backend stores a bounded byte suffix. This existing limitation is not expanded into an ANSI parser in this change. Replay settlement guarantees viewport position, not reconstruction of arbitrarily truncated terminal state.

## Testing

### Backend and launch unit tests

- Fresh and resume Codex argv include one `--no-alt-screen` in the global-option segment.
- Model/reasoning overrides, resume ordering, and initial prompt remain unchanged.
- Initial grid parsing accepts lower/upper bounds and ordinary fitted sizes.
- Missing, partial, decimal, negative, zero, oversized, and non-numeric pairs fall back atomically to `120x40`.

### Frontend unit tests

- Normal `viewportY < baseY` shows eligibility; equality and greater values are bottom.
- Alternate buffer is ineligible.
- Replaying/unsettled suppresses the button.
- Replay callback/timeout races release input without consuming or duplicating the callback-owned bottom settlement.
- Fit preserves bottom only when follow-bottom intent was already active.
- User scroll-up clears follow intent; jumping restores it.

### Automated browser/integration checks

- A fake agent-terminal WebSocket observes fitted `cols`/`rows` in the initial URL, and observes no grid pair when the first fit fails.
- Every attach receives one replay frame, including an empty snapshot, before live output.
- Output emitted after snapshot capture but before replay delivery is received exactly once after replay and in FIFO order.
- A replayed normal-buffer transcript opens at bottom without button flicker.
- Scrolling upward shows the accessible button; activating it reaches bottom, hides the button, and focuses xterm.
- Live output while scrolled upward does not move the viewport.
- Switching to another dock session and back repeatedly opens at bottom.
- Font-ready, late-fit, side-rail resize, and reconnect paths retain bottom anchoring.

### Manual verification

- Run a real Codex 0.147 terminal beyond one screen, scroll upward, use the Pinloom button, switch sessions repeatedly, and verify earlier output remains accessible.
- Repeat with a Claude terminal to confirm the shared control does not interfere with Claude's TUI.
- Check light/dark themes and all dock positions.

## Rollout and rollback

No migration or dependency is added. Rollback removes the Codex flag, initial grid query parsing, and frontend scroll controller/button independently. The existing PTY sessions, transcript capture, and message history are not modified.

## Deferred work

- Persisting the exact user viewport across hidden-panel unmounts.
- Keeping xterm/WS instances alive while hidden.
- Semantic terminal-state serialization.
- ANSI boundary repair or Codex-specific escape-sequence rewriting.
- Forcing Codex raw-output mode.
