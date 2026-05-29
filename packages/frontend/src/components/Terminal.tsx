import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Interactive shell terminal wired to the backend /ws/terminal pty socket.
// The backend keeps the pty alive across disconnects, so reconnecting (page
// reload, tab switch, or the restart button) reattaches and replays
// scrollback. Protocol mirrors the backend: {t:'i'|'r'} out, {t:'o'|'x'} in.

type Status = 'open' | 'exited' | 'disconnected';

export function Terminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('open');
  const [exitCode, setExitCode] = useState<number | null>(null);
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
      // Fixed dark palette — terminals read better dark even in light mode;
      // full pinloom theming can come later.
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
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
      `${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(sessionId)}`,
    );
    let exited = false;
    // True while writing the reconnect scrollback replay. xterm auto-replies
    // to terminal queries (DA/DSR) found in that replayed stream; forwarding
    // those replies to the shell makes it echo junk like "1;2c". Drop
    // xterm→pty data during the replay window (live input is unaffected).
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
          // parsed; clear once xterm finishes processing this chunk.
          replaying = true;
          term.write(msg.d, () => {
            replaying = false;
          });
        } else {
          term.write(msg.d);
        }
      } else if (msg.t === 'x') {
        exited = true;
        setExitCode(typeof msg.code === 'number' ? msg.code : 0);
        setStatus('exited');
      }
    };
    ws.onclose = () => {
      if (!exited) setStatus('disconnected');
    };

    const dataSub = term.onData((d) => {
      if (replaying) return; // don't echo replay-triggered query replies to the shell
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
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId, connKey]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#1a1b26]">
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'open' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <button
            type="button"
            onClick={() => {
              setStatus('open');
              setExitCode(null);
              setConnKey((k) => k + 1);
            }}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)]"
          >
            {status === 'exited'
              ? `shell exited${exitCode != null ? ` (code ${exitCode})` : ''} — restart`
              : 'disconnected — reconnect'}
          </button>
        </div>
      )}
    </div>
  );
}
