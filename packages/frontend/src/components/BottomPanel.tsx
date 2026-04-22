import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  ScrollText,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { Session, Terminal as TerminalRow } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { TerminalPane } from './TerminalPane.js';

type ActivePanel = { kind: 'logs' } | { kind: 'terminal'; id: string };

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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActivePanel>({ kind: 'logs' });
  const [terminals, setTerminals] = useState<TerminalRow[]>([]);
  const [terminalsLoaded, setTerminalsLoaded] = useState(false);

  const [lines, setLines] = useState<LogLine[]>([]);
  const [unread, setUnread] = useState(0);
  const nextLineId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setUnread(0);
    nextLineId.current = 0;
  }, [session.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list = await api.listTerminals(projectId);
        if (list.length === 0) {
          // Always keep at least one terminal ready for the project
          const created = await api.createTerminal(projectId);
          list = [created];
        }
        if (!cancelled) {
          setTerminals(list);
          setTerminalsLoaded(true);
        }
      } catch {
        if (!cancelled) setTerminalsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
      if (!open || active.kind !== 'logs') setUnread((u) => u + parts.length);
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
    if (open && active.kind === 'logs') {
      setUnread(0);
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    }
  }, [open, active, lines.length]);

  async function addTerminal() {
    const created = await api.createTerminal(projectId);
    setTerminals((prev) => [...prev, created]);
    setActive({ kind: 'terminal', id: created.id });
    setOpen(true);
  }

  async function removeTerminal(id: string) {
    if (terminals.length <= 1) {
      alert('At least one terminal must stay open.');
      return;
    }
    if (!confirm('Close this terminal? The shell process will be killed.')) return;
    await api.deleteTerminal(id);
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (active.kind === 'terminal' && active.id === id) {
        const fallback = next[0];
        setActive(fallback ? { kind: 'terminal', id: fallback.id } : { kind: 'logs' });
      }
      return next;
    });
  }

  const activeTerminalId =
    active.kind === 'terminal' && terminals.some((t) => t.id === active.id)
      ? active.id
      : null;

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

        <PanelTab
          label="Logs"
          icon={<ScrollText size={12} />}
          active={active.kind === 'logs'}
          badge={unread > 0 && (!open || active.kind !== 'logs') ? unread : undefined}
          onClick={() => {
            setActive({ kind: 'logs' });
            setOpen(true);
          }}
        />

        <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />

        {terminalsLoaded &&
          terminals.map((t, i) => (
            <PanelTab
              key={t.id}
              label={t.title ?? `Term ${i + 1}`}
              icon={<TerminalSquare size={12} />}
              active={active.kind === 'terminal' && active.id === t.id}
              onClick={() => {
                setActive({ kind: 'terminal', id: t.id });
                setOpen(true);
              }}
              onClose={() => removeTerminal(t.id)}
            />
          ))}
        <button
          onClick={addTerminal}
          title="New terminal"
          className="p-1 rounded text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
        >
          <Plus size={12} />
        </button>

        <div className="flex-1" />
        <span className="font-mono text-[10px] text-[var(--color-ink-muted)] px-1">
          {session.id.slice(0, 8)}
        </span>
      </div>

      {open && (
        <div className="h-56 border-t border-[var(--color-border)]">
          {active.kind === 'logs' ? (
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
          ) : activeTerminalId ? (
            <TerminalPane key={activeTerminalId} terminalId={activeTerminalId} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-ink-muted)]">
              Terminal closed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PanelTab({
  label,
  icon,
  active,
  badge,
  onClick,
  onClose,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer ${
        active
          ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]/60 hover:text-[var(--color-ink)]'
      }`}
      onClick={onClick}
    >
      {icon}
      <span className="truncate max-w-[140px]">{label}</span>
      {badge !== undefined && (
        <span className="rounded bg-[var(--color-accent)] text-black px-1 text-[9px]">
          {badge}
        </span>
      )}
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
