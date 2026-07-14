import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Minus, Plus, RotateCw } from 'lucide-react';
import type { WsEvent } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { currentXtermTheme, watchXtermTheme } from './xtermTheme.js';
import { installUnicodeCopy } from '../utils/xtermClipboard.js';

// Terminal-chat mode: a session's real `claude` TUI rendered live in xterm.js,
// wired to the backend /ws/agent-terminal pty socket. The human types directly
// into the TUI so streaming + native slash commands (/model, /effort, …) come
// for free. The backend keeps the pty alive across disconnects, so reconnecting
// reattaches + replays scrollback. Protocol mirrors /ws/terminal:
//   client→server: {t:'i',d} input · {t:'r',c,r} resize
//   server→client: {t:'o',d} output · {t:'x',code} agent exited

type Status = 'open' | 'exited' | 'disconnected';

export function AgentTerminal({
  sessionId,
  onCleanExit,
}: {
  sessionId: string;
  /**
   * Close this tab (= delete the session, same as the X button). Offered as the
   * "Close tab" action on the exit overlay — we don't auto-delete on exit, since
   * `exit` is easy to fire by reflex; the human confirms by clicking.
   */
  onCleanExit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // True briefly while a relaunch is in flight, so the kill's exit event doesn't
  // flash the "agent exited" overlay before the auto-reconnect lands.
  const relaunchingRef = useRef(false);
  // Per-terminal font zoom, independent of browser/app zoom. Persisted globally
  // (a font-size preference, not per-session). Refs let the +/- handlers reach
  // the live term/fit/ws without re-running the create effect (which would drop
  // scrollback). fontSizeRef carries the latest value into a reconnect respawn.
  const TERMINAL_FONT_KEY = 'pinloom:terminalFontSize';
  const [fontSize, setFontSize] = useState(() => {
    const v = Number(localStorage.getItem(TERMINAL_FONT_KEY));
    return v >= 8 && v <= 28 ? v : 12;
  });
  const fontSizeRef = useRef(fontSize);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('open');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  const [connKey, setConnKey] = useState(0);
  // True while an orchestrator dispatch is driving this worker's TUI — the
  // backend locks out human keystrokes, so we show an overlay explaining why.
  const [dispatchLocked, setDispatchLocked] = useState(false);

  const onWsEvent = useCallback(
    (ev: WsEvent) => {
      if (ev.type === 'terminal_lock' && ev.sessionId === sessionId) {
        setDispatchLocked(ev.locked);
      } else if (ev.type === 'terminal_relaunch' && ev.sessionId === sessionId) {
        // The backend killed this session's claude because its launch config
        // changed (it just became a team orchestrator → needs the MCP server).
        // Re-attach: the terminal is gone, so this respawns with the new config.
        relaunchingRef.current = true;
        setTimeout(() => {
          relaunchingRef.current = false;
        }, 3000);
        setStatus('open');
        setExitCode(null);
        setBlockedMsg(null);
        setConnKey((k) => k + 1);
      }
    },
    [sessionId],
  );
  useWebSocket(`session:${sessionId}`, onWsEvent);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: fontSizeRef.current,
      cursorBlink: true,
      theme: currentXtermTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container);

    const disposeCopy = installUnicodeCopy(container, term);
    const disposeTheme = watchXtermTheme(term);
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // container not measurable yet
      }
    };
    safeFit();
    const rafId = requestAnimationFrame(safeFit);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/agent-terminal?session=${encodeURIComponent(sessionId)}`,
    );
    wsRef.current = ws;
    let exited = false;

    // Shift+Enter → newline (not submit). Plain xterm encodes Shift+Enter the
    // same as Enter (\r = submit), so the TUI can't tell them apart. Send a
    // bare LF (\n, i.e. what Ctrl+J emits) — Claude Code (and readline TUIs
    // generally) insert a newline on LF while CR submits. This is the
    // "works in every terminal with no setup" path. Returning false
    // suppresses xterm's default \r.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        // preventDefault is essential: returning false only stops xterm from
        // processing the keydown — without it the browser still fires keypress
        // for Enter, which xterm turns into \r (submit). Cancel the native
        // sequence and send a bare LF ourselves.
        e.preventDefault();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'i', d: '\n' }));
        }
        return false;
      }
      return true;
    });
    // Drop xterm→pty data while replaying scrollback (xterm auto-replies to
    // DA/DSR queries embedded in the replay; forwarding those to the TUI echoes junk).
    let replaying = false;

    const sendResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
      }
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, 80);
    };

    ws.onopen = () => {
      setStatus('open');
      setBlockedMsg(null);
      relaunchingRef.current = false; // reconnect landed — drop the relaunch guard
      requestAnimationFrame(sendResize);
      term.focus();
    };
    ws.onmessage = (ev) => {
      let msg: { t?: string; d?: unknown; code?: unknown; replay?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.t === 'o' && typeof msg.d === 'string') {
        if (msg.replay) {
          replaying = true;
          term.write(msg.d, () => {
            replaying = false;
          });
        } else {
          term.write(msg.d);
        }
      } else if (msg.t === 'x') {
        exited = true;
        // A relaunch (e.g. became an orchestrator) kills the pty on purpose; the
        // terminal_relaunch handler is reconnecting, so don't show the overlay.
        if (relaunchingRef.current) return;
        setExitCode(typeof msg.code === 'number' ? msg.code : 0);
        setStatus('exited');
      }
    };
    ws.onclose = (ev) => {
      if (exited) return;
      // 4001 no-session/no-cwd · 4002 capped · 4003 spawn failed (CLI not on
      // PATH etc.) — all are terminal conditions the user must act on, so show
      // the reason instead of silently dropping into a reconnect.
      if (ev.code === 4001 || ev.code === 4002 || ev.code === 4003) {
        setBlockedMsg(ev.reason || 'agent terminal unavailable');
      }
      setStatus('disconnected');
    };

    const dataSub = term.onData((d) => {
      if (replaying) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'i', d }));
      }
    });

    const ro = new ResizeObserver(debouncedResize);
    ro.observe(container);

    // xterm derives cols/rows from the measured character-cell size, which is
    // wrong until the terminal font has actually loaded AND the pane has settled.
    // In the desktop app that's often not yet true at mount (a browser usually
    // has the font cached), so the first fit computes too few rows and the TUI's
    // input line ends up mid-pane. The ResizeObserver can't catch this — the
    // CONTAINER size never changes, only the cell size does — so refit explicitly
    // once fonts settle and once more a beat later. (A manual page refresh "fixes"
    // it for the same reason: by then everything is measured.)
    void document.fonts?.ready?.then(() => sendResize());
    const lateFitTimer = setTimeout(sendResize, 300);

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      clearTimeout(lateFitTimer);
      ro.disconnect();
      disposeCopy();
      disposeTheme();
      dataSub.dispose();
      ws.close();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [sessionId, connKey]);

  // +/- font zoom for this terminal only (independent of app/browser zoom).
  // Mutates the live term in place + refits so cols/rows + the pty resize stay
  // in sync; never re-creates the term, so scrollback survives.
  function changeFontSize(delta: number) {
    const next = Math.max(8, Math.min(28, fontSizeRef.current + delta));
    if (next === fontSizeRef.current) return;
    fontSizeRef.current = next;
    setFontSize(next);
    try {
      localStorage.setItem(TERMINAL_FONT_KEY, String(next));
    } catch {
      // localStorage unavailable; the change still applies for this session
    }
    const term = termRef.current;
    if (term) {
      term.options.fontSize = next;
      try {
        fitRef.current?.fit();
      } catch {
        // container not measurable; next ResizeObserver tick refits
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
      }
    }
  }

  const restart = () => {
    setStatus('open');
    setExitCode(null);
    setBlockedMsg(null);
    setConnKey((k) => k + 1);
  };

  // Auto-reconnect when the window regains focus/visibility and the socket had
  // dropped (backgrounded long enough that the browser closed the WS). The pty
  // is kept alive on the backend, so this just re-attaches + replays scrollback
  // — no manual "reconnect" click needed. Only for 'disconnected'; a genuine
  // 'exited' agent still requires the explicit overlay action.
  useEffect(() => {
    if (status !== 'disconnected') return;
    function onWake() {
      if (document.visibilityState === 'visible') restart();
    }
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const btnClass =
    'rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)]';

  return (
    <div className="group relative h-full w-full overflow-hidden bg-[var(--terminal-bg)]">
      <div ref={containerRef} className="h-full w-full" />
      {/* Per-terminal font zoom — appears on hover, top-right. Independent of
          the app/browser zoom so you can size the TUI on its own. */}
      {status === 'open' && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={() => changeFontSize(-1)}
            disabled={fontSize <= 8}
            title="Smaller text"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Minus size={12} />
          </button>
          <span className="w-6 text-center text-[10px] tabular-nums text-[var(--color-ink-muted)] select-none">
            {fontSize}
          </span>
          <button
            type="button"
            onClick={() => changeFontSize(1)}
            disabled={fontSize >= 28}
            title="Larger text"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Plus size={12} />
          </button>
          <span className="mx-0.5 h-3.5 w-px bg-[var(--color-border)]" aria-hidden />
          <button
            type="button"
            onClick={restart}
            title="Reconnect terminal"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
          >
            <RotateCw size={12} />
          </button>
        </div>
      )}
      {dispatchLocked && status === 'open' && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-[var(--color-accent)] px-3 py-1 text-[10px] font-medium text-black shadow">
          orchestrator running — input locked
        </div>
      )}
      {status !== 'open' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-4 text-center">
          {status === 'exited' ? (
            <>
              <div className="max-w-xs space-y-1">
                <p className="text-xs text-[#c0caf5]">
                  {exitCode === 0
                    ? 'Session ended.'
                    : `Agent exited abnormally (code ${exitCode}).`}
                </p>
                {exitCode !== 0 && (
                  <p className="text-[11px] leading-relaxed text-[#c0caf5]/70">
                    If it exited right away, check the agent CLI is installed,
                    on PATH, and logged in.
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-[#c0caf5]/60">
                  Restart keeps the conversation and pins. Closing the tab deletes
                  this session (conversation and pins included).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={restart} className={btnClass}>
                  Restart
                </button>
                {onCleanExit && (
                  <button
                    type="button"
                    onClick={onCleanExit}
                    className="rounded border border-[#f7768e]/50 bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[#f7768e] hover:border-[#f7768e]"
                  >
                    Close tab (delete session)
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              {blockedMsg && <p className="text-xs text-[#c0caf5]">{blockedMsg}</p>}
              <button type="button" onClick={restart} className={btnClass}>
                {blockedMsg ? 'retry' : 'disconnected — reconnect'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
