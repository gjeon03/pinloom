import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { WsEvent } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';

// xterm palettes for the two app themes. The TUI emits its own ANSI colors;
// we set the background/foreground/cursor/selection + a light-friendly base
// 16-color ramp so a light app theme doesn't render the terminal on a dark
// slab (and bright-white text stays legible on a light background).
const DARK_XTERM: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
};
const LIGHT_XTERM: ITheme = {
  background: '#fbfbfc',
  foreground: '#26272e',
  cursor: '#26272e',
  cursorAccent: '#fbfbfc',
  selectionBackground: '#bcd5fb',
  // Pull the bright ramp down so a TUI using bold/bright white (common for
  // emphasis) stays readable on the light background.
  white: '#3b3d46',
  brightWhite: '#26272e',
};

function currentXtermTheme(): ITheme {
  return document.documentElement.dataset.theme === 'light'
    ? LIGHT_XTERM
    : DARK_XTERM;
}

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
      fontSize: 12,
      cursorBlink: true,
      theme: currentXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Re-theme live when the app flips light/dark (theme.ts sets
    // documentElement.dataset.theme). xterm applies options.theme on assignment.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentXtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
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
    let exited = false;
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

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      themeObserver.disconnect();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId, connKey]);

  const restart = () => {
    setStatus('open');
    setExitCode(null);
    setBlockedMsg(null);
    setConnKey((k) => k + 1);
  };

  const btnClass =
    'rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)]';

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--terminal-bg)]">
      <div ref={containerRef} className="h-full w-full" />
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
