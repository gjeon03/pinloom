import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { currentXtermTheme, watchXtermTheme } from './xtermTheme.js';

// Interactive shell terminal wired to the backend /ws/terminal pty socket.
// The backend keeps the pty alive across disconnects, so reconnecting (page
// reload, tab switch, or the restart button) reattaches and replays
// scrollback. Protocol mirrors the backend: {t:'i'|'r'} out, {t:'o'|'x'} in.

type Status = 'open' | 'exited' | 'disconnected';

export function Terminal({
  projectId,
  termId,
}: {
  projectId: string;
  termId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('open');
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Set when the backend refuses the connection (e.g. terminal limit) so the
  // overlay can explain why instead of a generic "disconnected".
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  // Bumping this remounts the socket+xterm (used by the restart button).
  const [connKey, setConnKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      // Prefer a Nerd Font so prompt/eza glyphs (git branch, file icons)
      // render instead of missing-glyph boxes. Falls back to plain monospace
      // when no Nerd Font is installed (icons box, text still fine).
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      // Follow the app's light/dark theme (shared with the agent terminal) so a
      // light app doesn't leave this panel on a dark slab.
      theme: currentXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const disposeTheme = watchXtermTheme(term);
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // container not measurable yet
      }
    };
    safeFit();
    // The panel/flex layout may not have its final height on this commit
    // (e.g. just opened or restored to a saved height). Refit after the
    // browser lays out so the grid fills the panel instead of leaving a gap.
    const rafId = requestAnimationFrame(safeFit);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/terminal?project=${encodeURIComponent(projectId)}&t=${encodeURIComponent(termId)}`,
    );
    let exited = false;
    // True while writing the reconnect scrollback replay. xterm auto-replies
    // to terminal queries (DA/DSR) found in that replayed stream; forwarding
    // those replies to the shell makes it echo junk like "1;2c". Drop
    // xterm→pty data during the replay window (live input is unaffected).
    let replaying = false;
    // Safety: a reattach to a TUI (nvim/less) replays a big alt-screen buffer;
    // if the write callback is slow/never fires, `replaying` would stay true and
    // SWALLOW ALL KEYBOARD INPUT (the terminal looks dead). Force-clear it.
    let replayTimer: ReturnType<typeof setTimeout> | null = null;
    const endReplay = () => {
      replaying = false;
      if (replayTimer) {
        clearTimeout(replayTimer);
        replayTimer = null;
      }
    };

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
          // Suppress xterm's query replies while the replayed scrollback is
          // parsed; clear once xterm finishes — or after a hard cap so input
          // can never be permanently swallowed.
          replaying = true;
          if (replayTimer) clearTimeout(replayTimer);
          replayTimer = setTimeout(endReplay, 1500);
          term.write(msg.d, endReplay);
        } else {
          term.write(msg.d);
        }
      } else if (msg.t === 'x') {
        exited = true;
        setExitCode(typeof msg.code === 'number' ? msg.code : 0);
        setStatus('exited');
      }
    };
    ws.onclose = (ev) => {
      if (exited) return;
      // 4002 = backend refused (terminal limit). Surface its reason.
      if (ev.code === 4002) {
        setBlockedMsg(ev.reason || 'terminal limit reached');
      }
      setStatus('disconnected');
    };

    const dataSub = term.onData((d) => {
      if (replaying) return; // don't echo replay-triggered query replies to the shell
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'i', d }));
      }
    });

    const ro = new ResizeObserver(debouncedResize);
    ro.observe(container);

    // xterm derives cols/rows from the measured cell size, which is wrong until
    // the font has actually loaded AND the panel settled to its final height. In
    // the desktop app the font often isn't cached at mount, so the first fit
    // computes too few rows → a full-screen TUI (nvim, less) draws into a
    // collapsed area and looks blank. Refit (and re-send the size to the pty)
    // once fonts settle and once more a beat later so the TUI gets a correct
    // SIGWINCH and redraws. (Mirrors AgentTerminal.)
    void document.fonts?.ready?.then(() => sendResize());
    const lateFitTimer = setTimeout(sendResize, 300);

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (replayTimer) clearTimeout(replayTimer);
      clearTimeout(lateFitTimer);
      ro.disconnect();
      disposeTheme();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [projectId, termId, connKey]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#1a1b26]">
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'open' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 px-4 text-center">
          {blockedMsg && (
            <p className="text-xs text-[#c0caf5]">{blockedMsg}</p>
          )}
          <button
            type="button"
            onClick={() => {
              setStatus('open');
              setExitCode(null);
              setBlockedMsg(null);
              setConnKey((k) => k + 1);
            }}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)]"
          >
            {status === 'exited'
              ? `shell exited${exitCode != null ? ` (code ${exitCode})` : ''} — restart`
              : blockedMsg
                ? 'retry'
                : 'disconnected — reconnect'}
          </button>
        </div>
      )}
    </div>
  );
}
