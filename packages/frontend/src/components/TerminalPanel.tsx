import { useEffect, useRef, useState } from 'react';
import type { Session } from '@planloom/shared';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface LogLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export function TerminalPanel({ session }: { session: Session | null }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const nextId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    nextId.current = 0;
  }, [session?.id]);

  useWebSocket(session ? `session:${session.id}` : null, (ev) => {
    if (ev.type === 'run_log' && session && ev.sessionId === session.id) {
      setLines((prev) => {
        const parts = ev.chunk.split('\n');
        const added: LogLine[] = [];
        for (const part of parts) {
          if (part.length === 0) continue;
          added.push({ id: nextId.current++, stream: ev.stream, text: part });
        }
        const next = [...prev, ...added];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    } else if (ev.type === 'run_status' && session && ev.sessionId === session.id) {
      if (ev.status === 'started') {
        setLines((prev) => [
          ...prev,
          { id: nextId.current++, stream: 'stdout', text: '── run started ──' },
        ]);
      } else if (ev.status === 'finished') {
        setLines((prev) => [
          ...prev,
          { id: nextId.current++, stream: 'stdout', text: '── run finished ──' },
        ]);
      } else if (ev.status === 'error') {
        setLines((prev) => [
          ...prev,
          {
            id: nextId.current++,
            stream: 'stderr',
            text: `── error: ${ev.error ?? 'unknown'} ──`,
          },
        ]);
      }
    }
  });

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [lines.length]);

  return (
    <aside className="border-l border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
      <header className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-muted)] flex justify-between">
        <span>Run logs</span>
        {session && <span className="font-mono opacity-60">{session.id.slice(0, 8)}</span>}
      </header>
      <div ref={bodyRef} className="flex-1 overflow-auto p-3 font-mono text-xs leading-snug">
        {lines.length === 0 && (
          <p className="text-[var(--color-ink-muted)]">
            {session
              ? 'Waiting for tool calls…'
              : 'Create a plan and start chatting to stream tool runs here.'}
          </p>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={line.stream === 'stderr' ? 'text-red-300' : 'text-[var(--color-ink)]/85'}
          >
            {line.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
