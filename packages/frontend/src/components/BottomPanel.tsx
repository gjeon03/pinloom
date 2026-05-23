import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import type { Session } from '@pinloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface Props {
  projectId: string;
  session: Session;
}

interface LogLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export function BottomPanel({ session }: Props) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [unread, setUnread] = useState(0);
  const nextLineId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

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
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
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
          onClick={() => setOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-[var(--color-surface-3)] text-[var(--color-ink)]"
        >
          <ScrollText size={12} />
          <span>Logs</span>
          {unread > 0 && !open && (
            <span className="rounded bg-[var(--color-accent)] text-black px-1 text-[9px]">
              {unread}
            </span>
          )}
        </button>

        <div className="flex-1" />
        {/*
          A grey 'Terminal — soon' pill + a session-id mono badge used to
          sit here. Both bled into the marketing screenshots and read as
          half-finished work — pulled until Terminal actually ships and
          the session id has a real reason to be visible.
        */}
      </div>

      {open && (
        <div className="h-56 border-t border-[var(--color-border)]">
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
        </div>
      )}
    </div>
  );
}
