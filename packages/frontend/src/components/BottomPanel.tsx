import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  ScrollText,
  SquareTerminal,
  X,
} from 'lucide-react';
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

interface TermTab {
  id: string;
  name: string;
}

interface PanelTabs {
  list: TermTab[];
  active: string; // 'logs' | termId
  seq: number; // monotonic next-id counter (ids never reused)
}

function loadTabs(key: string): PanelTabs {
  try {
    const s = JSON.parse(localStorage.getItem(key) || '');
    if (s && Array.isArray(s.list)) {
      return {
        list: s.list.filter(
          (t: unknown): t is TermTab =>
            !!t &&
            typeof (t as TermTab).id === 'string' &&
            typeof (t as TermTab).name === 'string',
        ),
        active: typeof s.active === 'string' ? s.active : 'logs',
        seq: typeof s.seq === 'number' ? s.seq : (s.list?.length ?? 0) + 1,
      };
    }
  } catch {
    // fall through to default
  }
  return { list: [{ id: '1', name: 'Terminal' }], active: 'logs', seq: 2 };
}

export function BottomPanel({ projectId, session }: Props) {
  // Per-project persisted layout (keyed by projectId, not global):
  //  - open/closed and height are simple keys
  //  - terminal tabs (list + active + name + id counter) live in one JSON key
  // The pin-panel splitter width is likewise per-project in HSplitter.
  const OPEN_KEY = `pinloom:bottompanel:open:${projectId}`;
  const HEIGHT_KEY = `pinloom:bottompanel:height:${projectId}`;
  const TABS_KEY = `pinloom:bottompanel:terms:${projectId}`;
  const MIN_HEIGHT = 120;

  const [open, setOpen] = useState<boolean>(
    () => localStorage.getItem(OPEN_KEY) === '1',
  );
  const [tabs, setTabs] = useState<PanelTabs>(() => loadTabs(TABS_KEY));
  const [editingId, setEditingId] = useState<string | null>(null);
  const nameBeforeEdit = useRef('');

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
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  }, [tabs, TABS_KEY]);

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
    if (open && tabs.active === 'logs') {
      setUnread(0);
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    }
  }, [open, tabs.active, lines.length]);

  function selectTab(id: string) {
    setOpen(true);
    setTabs((t) => ({ ...t, active: id }));
  }

  function addTerminal() {
    setOpen(true);
    setTabs((t) => {
      const id = String(t.seq);
      return {
        list: [...t.list, { id, name: `Terminal ${t.seq}` }],
        active: id,
        seq: t.seq + 1,
      };
    });
  }

  function closeTerminal(id: string) {
    setTabs((t) => {
      const list = t.list.filter((x) => x.id !== id);
      const active =
        t.active === id ? (list[list.length - 1]?.id ?? 'logs') : t.active;
      return { ...t, list, active };
    });
    if (editingId === id) setEditingId(null);
  }

  function renameTerminal(id: string, name: string) {
    setTabs((t) => ({
      ...t,
      list: t.list.map((x) => (x.id === id ? { ...x, name } : x)),
    }));
  }

  const tabButtonClass = (isActive: boolean) =>
    isActive
      ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]';

  const activeTerm = tabs.list.find((t) => t.id === tabs.active) ?? null;

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
          // tab strip keeps symmetric top/bottom padding.
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
          onClick={() => selectTab('logs')}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] ${tabButtonClass(
            open && tabs.active === 'logs',
          )}`}
        >
          <ScrollText size={12} />
          <span>Logs</span>
          {unread > 0 && !open && (
            <span className="rounded bg-[var(--color-accent)] text-black px-1 text-[9px]">
              {unread}
            </span>
          )}
        </button>

        {tabs.list.map((t) =>
          editingId === t.id ? (
            <input
              key={t.id}
              autoFocus
              value={t.name}
              onChange={(e) => renameTerminal(t.id, e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => {
                setEditingId(null);
                renameTerminal(t.id, t.name.trim() || 'Terminal');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  renameTerminal(t.id, nameBeforeEdit.current);
                  setEditingId(null);
                }
              }}
              className="w-24 px-2 py-1 rounded text-[11px] bg-[var(--color-surface-3)] text-[var(--color-ink)] border border-[var(--color-accent)] outline-none"
            />
          ) : (
            <div
              key={t.id}
              className={`flex items-center rounded text-[11px] ${tabButtonClass(
                open && tabs.active === t.id,
              )}`}
            >
              <button
                type="button"
                onClick={() => selectTab(t.id)}
                onDoubleClick={() => {
                  selectTab(t.id);
                  nameBeforeEdit.current = t.name;
                  setEditingId(t.id);
                }}
                title="Double-click to rename"
                className="flex items-center gap-1 pl-2 pr-1 py-1"
              >
                <SquareTerminal size={12} />
                <span>{t.name}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.id);
                }}
                title="Close terminal"
                className="pl-0.5 pr-1.5 py-1 opacity-50 hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ),
        )}

        <button
          type="button"
          onClick={addTerminal}
          title="New terminal"
          className="p-1 rounded text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <Plus size={13} />
        </button>

        <div className="flex-1" />
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
          {tabs.active === 'logs' || !activeTerm ? (
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
                    line.stream === 'stderr'
                      ? 'text-red-300'
                      : 'text-[var(--color-ink)]/85'
                  }
                >
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <Terminal
              key={activeTerm.id}
              projectId={projectId}
              termId={activeTerm.id}
            />
          )}
        </div>
      )}
    </div>
  );
}
