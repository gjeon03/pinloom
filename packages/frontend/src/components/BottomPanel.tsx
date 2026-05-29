import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ScrollText, SquareTerminal } from 'lucide-react';
import type { Session } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { Terminal } from './Terminal.js';

interface Props {
  projectId: string;
  session: Session;
}

interface LogLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export function BottomPanel({ projectId, session }: Props) {
  // Per-project persisted layout: open/closed + height are scoped to the
  // project so each one remembers its own panel state (keyed by projectId,
  // not global). The pin-panel splitter width is likewise per-project in
  // HSplitter (pinloom:splitter:<projectId>).
  const OPEN_KEY = `pinloom:bottompanel:open:${projectId}`;
  const HEIGHT_KEY = `pinloom:bottompanel:height:${projectId}`;
  const TAB_KEY = `pinloom:bottompanel:tab:${projectId}`;
  const MIN_HEIGHT = 120;

  const [open, setOpen] = useState<boolean>(
    () => localStorage.getItem(OPEN_KEY) === '1',
  );
  const [tab, setTab] = useState<'logs' | 'terminal'>(() =>
    localStorage.getItem(TAB_KEY) === 'terminal' ? 'terminal' : 'logs',
  );
  const [lines, setLines] = useState<LogLine[]>([]);
  const [unread, setUnread] = useState(0);
  const nextLineId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Draggable panel height. The Terminal/xterm inside refits automatically
  // via its ResizeObserver when this changes.
  const [height, setHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    return saved >= MIN_HEIGHT ? saved : 224;
  });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (!dragStart.current) return;
      const delta = dragStart.current.y - e.clientY; // drag up → taller
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 160);
      setHeight(
        Math.max(MIN_HEIGHT, Math.min(maxHeight, dragStart.current.h + delta)),
      );
    }
    function onUp() {
      setDragging(false);
    }
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height, HEIGHT_KEY]);

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  }, [open, OPEN_KEY]);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab, TAB_KEY]);

  useEffect(() => {
    setLines([]);
    setUnread(0);
    nextLineId.current = 0;
  }, [session.id]);

  useWebSocket(`session:${session.id}`, (ev) => {
    if (ev.type === 'run_log' && ev.sessionId === session.id) {
      const parts = ev.chunk.split('\n').filter((p) => p.length > 0);
      if (parts.length === 0) return;
      setLines((prev) => {
        const added: LogLine[] = parts.map((p) => ({
          id: nextLineId.current++,
          stream: ev.stream,
          text: p,
        }));
        const next = [...prev, ...added];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
      if (!open) setUnread((u) => u + parts.length);
    } else if (ev.type === 'run_status' && ev.sessionId === session.id) {
      const marker =
        ev.status === 'started'
          ? '── run started ──'
          : ev.status === 'finished'
            ? '── run finished ──'
            : `── error: ${ev.error ?? 'unknown'} ──`;
      setLines((prev) => [
        ...prev,
        {
          id: nextLineId.current++,
          stream: ev.status === 'error' ? 'stderr' : 'stdout',
          text: marker,
        },
      ]);
    }
  });

  useEffect(() => {
    if (open) {
      setUnread(0);
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    }
  }, [open, lines.length]);

  return (
    <div className="relative border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
      {open && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            dragStart.current = { y: e.clientY, h: height };
            setDragging(true);
          }}
          title="Drag to resize"
          // Overlay the top border instead of taking layout height, so the
          // tab strip keeps symmetric top/bottom padding (the in-flow handle
          // used to add ~6px only above the tabs).
          className={`absolute inset-x-0 -top-[3px] z-10 h-1.5 cursor-ns-resize hover:bg-[var(--color-accent)]/40 ${
            dragging ? 'bg-[var(--color-accent)]/40' : ''
          }`}
        />
      )}
      <div className="flex items-center px-2 py-0.5 text-xs gap-0.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse panel' : 'Expand panel'}
          className="p-1 rounded text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setTab('logs');
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] ${
            open && tab === 'logs'
              ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          }`}
        >
          <ScrollText size={12} />
          <span>Logs</span>
          {unread > 0 && !open && (
            <span className="rounded bg-[var(--color-accent)] text-black px-1 text-[9px]">
              {unread}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setTab('terminal');
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] ${
            open && tab === 'terminal'
              ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          }`}
        >
          <SquareTerminal size={12} />
          <span>Terminal</span>
        </button>

        <div className="flex-1" />
        {/*
          A grey 'Terminal — soon' pill used to sit here next to the
          session id badge. It read as half-finished work in launch
          screenshots and the Terminal feature wasn't actually on a
          schedule, so we pulled the pill. The session-id badge stays —
          it's a short-hash identifier the operator can quote in bug
          reports or use to distinguish sessions that share a title.
        */}
        <span
          title={`Session ${session.id}`}
          className="font-mono text-[10px] text-[var(--color-ink-muted)] px-1"
        >
          {session.id.slice(0, 8)}
        </span>
      </div>

      {open && (
        <div
          style={{ height }}
          className="border-t border-[var(--color-border)]"
        >
          {tab === 'logs' ? (
            <div
              ref={bodyRef}
              className="h-full overflow-auto px-4 py-2 font-mono text-xs leading-snug"
            >
              {lines.length === 0 && (
                <p className="text-[var(--color-ink-muted)]">Waiting for tool calls…</p>
              )}
              {lines.map((line) => (
                <div
                  key={line.id}
                  className={
                    line.stream === 'stderr' ? 'text-red-300' : 'text-[var(--color-ink)]/85'
                  }
                >
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <Terminal sessionId={session.id} />
          )}
        </div>
      )}
    </div>
  );
}
