import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Terminal-chat mode: a session's real `claude` TUI rendered live in xterm.js,
// wired to the backend /ws/agent-terminal pty socket. The human types directly
// into the TUI so streaming + native slash commands (/model, /effort, …) come
// for free. The backend keeps the pty alive across disconnects, so reconnecting
// reattaches + replays scrollback. Protocol mirrors /ws/terminal:
//   client→server: {t:'i',d} input · {t:'r',c,r} resize
//   server→client: {t:'o',d} output · {t:'x',code} agent exited

type Status = 'open' | 'exited' | 'disconnected';

export function AgentTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('open');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  const [connKey, setConnKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
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
        setExitCode(typeof msg.code === 'number' ? msg.code : 0);
        setStatus('exited');
      }
    };
    ws.onclose = (ev) => {
      if (exited) return;
      if (ev.code === 4002 || ev.code === 4001) {
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
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId, connKey]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#1a1b26]">
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'open' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 px-4 text-center">
          {blockedMsg && <p className="text-xs text-[#c0caf5]">{blockedMsg}</p>}
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
              ? `agent exited${exitCode != null ? ` (code ${exitCode})` : ''} — restart`
              : blockedMsg
                ? 'retry'
                : 'disconnected — reconnect'}
          </button>
        </div>
      )}
    </div>
  );
}
