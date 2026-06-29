import { Fragment, useEffect, useRef, useState } from 'react';
import { Info, Plus, Rows2, SquarePen, X } from 'lucide-react';
import { api, type NotepadDoc, type NotepadTab } from '../api/client.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Tooltip } from './Tooltip.js';
import { useT } from '../i18n/t.js';

// The notepad is split into a toggle button (lives in the top-right control
// cluster) and a docked panel (a real right-hand column in the app layout).
// Docking — rather than an overlay — keeps the main content interactive
// (scroll/click) while the note is open.
//
// The panel holds a structured doc: tabs (shown only once there are 2+), each
// with a vertical stack of independent, resizable text panes.

const WIDTH_KEY = 'pinloom:notepad:width';
const MIN_WIDTH = 260;
const DEFAULT_WIDTH = 340;
const MIN_PANE_HEIGHT = 80;
const DEFAULT_PANE_HEIGHT = 200;

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Apply `fn` to the active tab only, returning a new doc.
function mapActiveTab(
  doc: NotepadDoc,
  fn: (tab: NotepadTab) => NotepadTab,
): NotepadDoc {
  return {
    ...doc,
    tabs: doc.tabs.map((t) => (t.id === doc.activeTabId ? fn(t) : t)),
  };
}

export function NotepadToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <Tooltip label={t('cmp.notepad.title')}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={t('cmp.notepad.title')}
        className={`rounded-md border bg-[var(--color-surface-2)] p-1.5 inline-flex items-center justify-center ${
          open
            ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]'
        }`}
      >
        <SquarePen size={16} />
      </button>
    </Tooltip>
  );
}

export function NotepadPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [doc, setDoc] = useState<NotepadDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const docRef = useRef<NotepadDoc | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Draggable panel width (left-edge handle), persisted globally.
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  });
  const [widthDragging, setWidthDragging] = useState(false);
  const widthDrag = useRef<{ x: number; w: number } | null>(null);

  // Pane-divider drag (resizes the pane above the divider).
  const [paneDragging, setPaneDragging] = useState(false);
  const paneDrag = useRef<{ paneId: string; y: number; h: number } | null>(null);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // Mutate the doc and flag it for autosave.
  function mutate(fn: (d: NotepadDoc) => NotepadDoc) {
    dirtyRef.current = true;
    setDoc((d) => (d ? fn(d) : d));
  }

  // Load once on mount (the panel mounts when opened).
  useEffect(() => {
    let cancelled = false;
    api
      .getNotepad()
      .then((r) => {
        if (!cancelled) {
          setDoc(r.doc);
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
    if (!loaded || !dirtyRef.current || !doc) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      api
        .saveNotepad(doc)
        .catch(() => {})
        .finally(() => {
          setSaving(false);
          dirtyRef.current = false;
        });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, loaded]);

  // Flush a pending edit if the panel is closed before the debounce fires.
  useEffect(() => {
    return () => {
      if (dirtyRef.current && docRef.current) {
        api.saveNotepad(docRef.current).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Panel width drag.
  useEffect(() => {
    if (!widthDragging) return;
    function onMove(e: MouseEvent) {
      if (!widthDrag.current) return;
      const delta = widthDrag.current.x - e.clientX; // drag left → wider
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 320);
      setWidth(
        Math.max(MIN_WIDTH, Math.min(maxWidth, widthDrag.current.w + delta)),
      );
    }
    function onUp() {
      setWidthDragging(false);
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
  }, [widthDragging]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  // Pane divider drag.
  useEffect(() => {
    if (!paneDragging) return;
    function onMove(e: MouseEvent) {
      const pd = paneDrag.current;
      if (!pd) return;
      const next = Math.max(MIN_PANE_HEIGHT, pd.h + (e.clientY - pd.y));
      dirtyRef.current = true;
      setDoc((d) =>
        d
          ? mapActiveTab(d, (t) => ({
              ...t,
              panes: t.panes.map((p) =>
                p.id === pd.paneId ? { ...p, height: next } : p,
              ),
            }))
          : d,
      );
    }
    function onUp() {
      setPaneDragging(false);
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
  }, [paneDragging]);

  // Tab + pane operations.
  function addTab() {
    mutate((d) => {
      const tab: NotepadTab = {
        id: makeId(),
        name: t('cmp.notepad.noteName', { n: d.tabs.length + 1 }),
        panes: [{ id: makeId(), content: '', height: DEFAULT_PANE_HEIGHT }],
      };
      return { ...d, tabs: [...d.tabs, tab], activeTabId: tab.id };
    });
  }

  function closeTab(id: string) {
    mutate((d) => {
      if (d.tabs.length <= 1) return d;
      const idx = d.tabs.findIndex((t) => t.id === id);
      const tabs = d.tabs.filter((t) => t.id !== id);
      let activeTabId = d.activeTabId;
      if (activeTabId === id) {
        activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
      }
      return { ...d, tabs, activeTabId };
    });
  }

  function renameTab(id: string, name: string) {
    mutate((d) => ({
      ...d,
      tabs: d.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    }));
  }

  function setActiveTab(id: string) {
    mutate((d) => ({ ...d, activeTabId: id }));
  }

  function addPane() {
    mutate((d) =>
      mapActiveTab(d, (t) => ({
        ...t,
        panes: [
          ...t.panes,
          { id: makeId(), content: '', height: DEFAULT_PANE_HEIGHT },
        ],
      })),
    );
  }

  function removePane(paneId: string) {
    mutate((d) =>
      mapActiveTab(d, (t) =>
        t.panes.length <= 1
          ? t
          : { ...t, panes: t.panes.filter((p) => p.id !== paneId) },
      ),
    );
  }

  function setPaneContent(paneId: string, content: string) {
    mutate((d) =>
      mapActiveTab(d, (t) => ({
        ...t,
        panes: t.panes.map((p) => (p.id === paneId ? { ...p, content } : p)),
      })),
    );
  }

  const activeTab = doc
    ? doc.tabs.find((t) => t.id === doc.activeTabId) ?? doc.tabs[0]
    : null;
  const showTabs = !!doc && doc.tabs.length > 1;

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
          widthDrag.current = { x: e.clientX, w: width };
          setWidthDragging(true);
        }}
        title={t('cmp.notepad.dragResize')}
        className={`absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-ew-resize hover:bg-[var(--color-accent)]/40 ${
          widthDragging ? 'bg-[var(--color-accent)]/40' : ''
        }`}
      />

      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <SquarePen size={14} />
          {t('cmp.notepad.title')}
          <Tooltip label={t('cmp.notepad.savedInfo')} side="bottom">
            <Info
              size={13}
              className="cursor-help text-[var(--color-ink-muted)]"
            />
          </Tooltip>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[10px] text-[var(--color-ink-muted)]">
            {saving ? t('cmp.notepad.saving') : loaded ? t('cmp.notepad.saved') : ''}
          </span>
          <button
            type="button"
            onClick={addPane}
            title={t('cmp.notepad.split')}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <Rows2 size={14} />
          </button>
          <button
            type="button"
            onClick={addTab}
            title={t('cmp.notepad.newTab')}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('cmp.notepad.close')}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {showTabs && doc && (
        <div className="flex items-center overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] pl-2">
          {doc.tabs.map((t) => (
            <TabChip
              key={t.id}
              name={t.name}
              active={t.id === doc.activeTabId}
              hasContent={t.panes.some((p) => p.content.trim() !== '')}
              onSelect={() => setActiveTab(t.id)}
              onClose={() => closeTab(t.id)}
              onRename={(name) => renameTab(t.id, name)}
            />
          ))}
        </div>
      )}

      {activeTab ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {activeTab.panes.map((pane, i) => {
            const isLast = i === activeTab.panes.length - 1;
            return (
              <Fragment key={pane.id}>
                <div
                  className={`group relative ${
                    isLast ? 'min-h-[120px] flex-1' : 'shrink-0'
                  }`}
                  style={isLast ? undefined : { height: pane.height }}
                >
                  {activeTab.panes.length > 1 && (
                    <span className="absolute right-1 top-1 z-10">
                      <ConfirmButton
                        needsConfirm={pane.content.trim() !== ''}
                        message={t('cmp.notepad.removePaneConfirm')}
                        onConfirm={() => removePane(pane.id)}
                        title={t('cmp.notepad.removePane')}
                        className="rounded p-0.5 text-[var(--color-ink-muted)] opacity-0 hover:text-red-400 group-hover:opacity-100"
                      >
                        <X size={11} />
                      </ConfirmButton>
                    </span>
                  )}
                  <textarea
                    autoFocus={i === 0}
                    value={pane.content}
                    onChange={(e) => setPaneContent(pane.id, e.target.value)}
                    placeholder={t('cmp.notepad.placeholder')}
                    className="h-full w-full resize-none bg-[var(--color-surface)] px-4 py-3 text-sm font-mono leading-relaxed outline-none"
                  />
                </div>
                {!isLast && (
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      paneDrag.current = {
                        paneId: pane.id,
                        y: e.clientY,
                        h: pane.height,
                      };
                      setPaneDragging(true);
                    }}
                    title={t('cmp.notepad.dragResize')}
                    className={`h-1.5 shrink-0 cursor-ns-resize border-y border-[var(--color-border)] hover:bg-[var(--color-accent)]/40 ${
                      paneDragging ? 'bg-[var(--color-accent)]/40' : ''
                    }`}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center text-xs text-[var(--color-ink-muted)]">
          {t('cmp.notepad.loading')}
        </div>
      )}
    </div>
  );
}

function TabChip({
  name,
  active,
  hasContent,
  onSelect,
  onClose,
  onRename,
}: {
  name: string;
  active: boolean;
  hasContent: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = draft.trim();
          if (next && next !== name) onRename(next);
          else setDraft(name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(name);
            setEditing(false);
          }
        }}
        className="my-1 w-24 shrink-0 rounded bg-[var(--color-surface)] px-2 py-0.5 text-xs outline-none ring-1 ring-[var(--color-accent)]"
      />
    );
  }

  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title={t('cmp.notepad.dblClickRename')}
      className={`group flex shrink-0 cursor-pointer items-center gap-1 rounded-t border-b-2 px-3 py-1.5 text-xs ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-ink)]'
          : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      <span className="max-w-[120px] truncate">{name}</span>
      <ConfirmButton
        needsConfirm={hasContent}
        message={t('cmp.notepad.deleteTabConfirm')}
        onConfirm={onClose}
        title={t('cmp.notepad.closeTab')}
        className="opacity-0 hover:text-red-400 group-hover:opacity-100"
      >
        <X size={11} />
      </ConfirmButton>
    </div>
  );
}
