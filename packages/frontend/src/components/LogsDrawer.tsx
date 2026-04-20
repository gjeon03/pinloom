import { useEffect, useRef, useState } from 'react';
import type { Session } from '@planloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface LogLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export function LogsDrawer({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [unread, setUnread] = useState(0);
  const nextId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setUnread(0);
    nextId.current = 0;
  }, [session.id]);

  useWebSocket(`session:${session.id}`, (ev) => {
    if (ev.type === 'run_log' && ev.sessionId === session.id) {
      const parts = ev.chunk.split('\n').filter((p) => p.length > 0);
      if (parts.length === 0) return;
      setLines((prev) => {
        const added: LogLine[] = parts.map((p) => ({
          id: nextId.current++,
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
          id: nextId.current++,
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between px-4 py-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <span className="flex items-center gap-2">
          <span>{open ? '▾' : '▸'}</span>
          <span>Run logs</span>
          {unread > 0 && !open && (
            <span className="rounded bg-[var(--color-accent)] text-black px-1.5 text-[10px]">
              {unread}
            </span>
          )}
        </span>
        <span className="font-mono opacity-60">{session.id.slice(0, 8)}</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="h-56 overflow-auto px-4 pb-3 font-mono text-xs leading-snug border-t border-[var(--color-border)]"
        >
          {lines.length === 0 && (
            <p className="text-[var(--color-ink-muted)] mt-2">Waiting for tool calls…</p>
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
      )}
    </div>
  );
}
