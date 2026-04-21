import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  terminalId: string;
}

export function TerminalPane({ terminalId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#0f1014',
        foreground: '#e5e5e5',
        cursor: '#7dd3df',
        selectionBackground: '#2d3748',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${wsProtocol}://${location.host}/ws/terminal?terminalId=${encodeURIComponent(terminalId)}`,
    );

    let wsReady = false;

    ws.addEventListener('open', () => {
      wsReady = true;
      const { cols, rows } = term;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          data?: string;
          exitCode?: number;
        };
        if (msg.type === 'data' && typeof msg.data === 'string') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.write(
            `\r\n\x1b[31m[process exited with code ${msg.exitCode ?? 0}]\x1b[0m\r\n`,
          );
        }
      } catch {
        // ignore malformed
      }
    });

    ws.addEventListener('close', () => {
      wsReady = false;
    });

    const dataSub = term.onData((data) => {
      if (wsReady) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      if (wsReady) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore layout transition errors
      }
    });
    observer.observe(host);

    term.focus();

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
      term.dispose();
    };
  }, [terminalId]);

  return <div ref={hostRef} className="w-full h-full" />;
}
