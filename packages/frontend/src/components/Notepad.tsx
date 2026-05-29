import { useEffect, useRef, useState } from 'react';
import { Info, NotepadText, X } from 'lucide-react';
import { api } from '../api/client.js';
import { Tooltip } from './Tooltip.js';

// The notepad is split into a toggle button (lives in the top-right control
// cluster) and a docked panel (a real right-hand column in the app layout).
// Docking — rather than an overlay — keeps the main content interactive
// (scroll/click) while the note is open.

const WIDTH_KEY = 'pinloom:notepad:width';
const MIN_WIDTH = 260;
const DEFAULT_WIDTH = 340;

export function NotepadToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Notepad"
      className={`rounded-full border bg-[var(--color-surface-2)]/90 p-2 shadow-md backdrop-blur-sm inline-flex items-center justify-center ${
        open
          ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
      }`}
    >
      <NotepadText size={14} />
    </button>
  );
}

export function NotepadPanel({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const contentRef = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Draggable panel width (left-edge handle), persisted globally.
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (!dragStart.current) return;
      const delta = dragStart.current.x - e.clientX; // drag left → wider
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 320);
      setWidth(
        Math.max(MIN_WIDTH, Math.min(maxWidth, dragStart.current.w + delta)),
      );
    }
    function onUp() {
      setDragging(false);
    }
    document.body.style.cursor = 'ew-resize';
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
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Load once on mount (the panel mounts when opened).
  useEffect(() => {
    let cancelled = false;
    api
      .getNotepad()
      .then((r) => {
        if (!cancelled) {
          setContent(r.content);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced autosave on genuine edits (dirtyRef gates out the load).
  useEffect(() => {
    if (!loaded || !dirtyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      api
        .saveNotepad(content)
        .catch(() => {})
        .finally(() => {
          setSaving(false);
          dirtyRef.current = false;
        });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, loaded]);

  // Flush a pending edit if the panel is closed before the debounce fires.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) api.saveNotepad(contentRef.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)]"
      style={{ width }}
    >
      {/* Left-edge resize handle — overlays the border so it adds no layout
          width. Drag left to widen, right to narrow. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          dragStart.current = { x: e.clientX, w: width };
          setDragging(true);
        }}
        title="Drag to resize"
        className={`absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-ew-resize hover:bg-[var(--color-accent)]/40 ${
          dragging ? 'bg-[var(--color-accent)]/40' : ''
        }`}
      />
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <NotepadText size={14} />
          Notepad
          <Tooltip label="Saved to the local SQLite DB" side="bottom">
            <Info
              size={13}
              className="cursor-help text-[var(--color-ink-muted)]"
            />
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-ink-muted)]">
            {saving ? 'saving…' : loaded ? 'saved' : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <textarea
        autoFocus
        value={content}
        onChange={(e) => {
          dirtyRef.current = true;
          setContent(e.target.value);
        }}
        placeholder="Quick notes…"
        className="flex-1 resize-none bg-[var(--color-surface)] px-4 py-3 text-sm font-mono leading-relaxed outline-none"
      />
    </div>
  );
}
