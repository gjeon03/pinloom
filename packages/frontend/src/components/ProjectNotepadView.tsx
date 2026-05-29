import { Fragment, useEffect, useRef, useState } from 'react';
import { Columns2, Rows2, X } from 'lucide-react';
import type { NotepadNode } from '@pinloom/shared';
import { projectNotepadApi } from '../api/client.js';
import { ConfirmButton } from './ConfirmButton.js';

// Editor for a single project notepad. The body is a split tree of text
// panes: `dir: 'row'` lays children side-by-side, `dir: 'column'` stacks
// them. Every pane can be split either way and resized; the whole tree
// autosaves (PATCH root) on edits.

const MIN_PERCENT = 6;

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makePane(): NotepadNode {
  return { id: makeId(), kind: 'pane', content: '' };
}

function countPanes(node: NotepadNode): number {
  return node.kind === 'pane'
    ? 1
    : node.children.reduce((sum, c) => sum + countPanes(c), 0);
}

function setPaneContent(
  node: NotepadNode,
  paneId: string,
  content: string,
): NotepadNode {
  if (node.kind === 'pane') {
    return node.id === paneId ? { ...node, content } : node;
  }
  return {
    ...node,
    children: node.children.map((c) => setPaneContent(c, paneId, content)),
  };
}

function setSplitSizes(
  node: NotepadNode,
  splitId: string,
  sizes: number[],
): NotepadNode {
  if (node.kind === 'pane') return node;
  if (node.id === splitId) return { ...node, sizes };
  return {
    ...node,
    children: node.children.map((c) => setSplitSizes(c, splitId, sizes)),
  };
}

// Split a pane. If the target is a direct child of a split with the same
// direction, insert a sibling (n-ary, flatter tree); otherwise wrap it in a
// nested split of the requested direction.
function splitPane(
  node: NotepadNode,
  paneId: string,
  dir: 'row' | 'column',
): NotepadNode {
  if (node.kind === 'pane') {
    if (node.id !== paneId) return node;
    return { id: makeId(), kind: 'split', dir, sizes: [50, 50], children: [node, makePane()] };
  }
  const idx = node.children.findIndex(
    (c) => c.kind === 'pane' && c.id === paneId,
  );
  if (idx !== -1) {
    if (node.dir === dir) {
      const half = node.sizes[idx] / 2;
      const sizes = [...node.sizes];
      sizes[idx] = half;
      sizes.splice(idx + 1, 0, half);
      const children = [...node.children];
      children.splice(idx + 1, 0, makePane());
      return { ...node, sizes, children };
    }
    const children = node.children.map((c, i) =>
      i === idx
        ? ({
            id: makeId(),
            kind: 'split',
            dir,
            sizes: [50, 50],
            children: [c, makePane()],
          } satisfies NotepadNode)
        : c,
    );
    return { ...node, children };
  }
  return {
    ...node,
    children: node.children.map((c) => splitPane(c, paneId, dir)),
  };
}

// Remove a pane, collapsing single-child splits and renormalizing sibling
// sizes. Returns null when the subtree empties out (handled by the caller).
function removePane(node: NotepadNode, paneId: string): NotepadNode | null {
  if (node.kind === 'pane') {
    return node.id === paneId ? null : node;
  }
  const children: NotepadNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removePane(c, paneId);
    if (r !== null) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => (s / sum) * 100) };
}

export function ProjectNotepadView({ notepadId }: { notepadId: string }) {
  const [root, setRoot] = useState<NotepadNode | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const rootRef = useRef<NotepadNode | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    rootRef.current = root;
  }, [root]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setRoot(null);
    projectNotepadApi
      .get(notepadId)
      .then((n) => {
        if (!cancelled) {
          setRoot(n.root);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [notepadId]);

  useEffect(() => {
    if (!loaded || !dirtyRef.current || !root) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      projectNotepadApi
        .update(notepadId, { root })
        .catch(() => {})
        .finally(() => {
          setSaving(false);
          dirtyRef.current = false;
        });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [root, loaded, notepadId]);

  // Flush a pending edit if the view unmounts (tab switch) before the
  // debounce fires.
  useEffect(() => {
    return () => {
      if (dirtyRef.current && rootRef.current) {
        projectNotepadApi
          .update(notepadId, { root: rootRef.current })
          .catch(() => {});
      }
    };
  }, [notepadId]);

  function mutate(fn: (r: NotepadNode) => NotepadNode | null) {
    dirtyRef.current = true;
    setRoot((r) => (r ? fn(r) ?? r : r));
  }

  if (!loaded || !root) {
    return (
      <div className="grid h-full place-items-center text-xs text-[var(--color-ink-muted)]">
        Loading…
      </div>
    );
  }

  const canRemove = countPanes(root) > 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-[var(--color-border)] px-3 py-1">
        <span className="text-[10px] text-[var(--color-ink-muted)]">
          {saving ? 'saving…' : 'saved'}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <NotepadNodeView
          node={root}
          canRemove={canRemove}
          onContentChange={(id, content) =>
            mutate((r) => setPaneContent(r, id, content))
          }
          onSplit={(id, dir) => mutate((r) => splitPane(r, id, dir))}
          onRemove={(id) => mutate((r) => removePane(r, id))}
          onResize={(splitId, sizes) =>
            mutate((r) => setSplitSizes(r, splitId, sizes))
          }
        />
      </div>
    </div>
  );
}

function NotepadNodeView({
  node,
  canRemove,
  onContentChange,
  onSplit,
  onRemove,
  onResize,
}: {
  node: NotepadNode;
  canRemove: boolean;
  onContentChange: (paneId: string, content: string) => void;
  onSplit: (paneId: string, dir: 'row' | 'column') => void;
  onRemove: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
}) {
  if (node.kind === 'pane') {
    return (
      <div className="group relative h-full w-full">
        <div className="absolute right-1 top-1 z-10 flex gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onSplit(node.id, 'column')}
            title="Split top / bottom"
            className="rounded bg-[var(--color-surface-2)] p-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
          >
            <Rows2 size={12} />
          </button>
          <button
            type="button"
            onClick={() => onSplit(node.id, 'row')}
            title="Split left / right"
            className="rounded bg-[var(--color-surface-2)] p-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
          >
            <Columns2 size={12} />
          </button>
          {canRemove && (
            <ConfirmButton
              needsConfirm={node.content.trim() !== ''}
              message="Remove this pane?"
              onConfirm={() => onRemove(node.id)}
              title="Remove pane"
              className="rounded bg-[var(--color-surface-2)] p-0.5 text-[var(--color-ink-muted)] hover:text-red-400"
            >
              <X size={12} />
            </ConfirmButton>
          )}
        </div>
        <textarea
          value={node.content}
          onChange={(e) => onContentChange(node.id, e.target.value)}
          placeholder="Notes…"
          className="h-full w-full resize-none bg-[var(--color-surface)] px-3 py-2 text-sm font-mono leading-relaxed outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={`flex h-full w-full ${
        node.dir === 'row' ? 'flex-row' : 'flex-col'
      }`}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="min-h-0 min-w-0 overflow-hidden"
            style={{ flexBasis: `${node.sizes[i]}%`, flexGrow: 0, flexShrink: 0 }}
          >
            <NotepadNodeView
              node={child}
              canRemove={canRemove}
              onContentChange={onContentChange}
              onSplit={onSplit}
              onRemove={onRemove}
              onResize={onResize}
            />
          </div>
          {i < node.children.length - 1 && (
            <Divider
              dir={node.dir}
              sizes={node.sizes}
              index={i}
              onResize={(sizes) => onResize(node.id, sizes)}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function Divider({
  dir,
  sizes,
  index,
  onResize,
}: {
  dir: 'row' | 'column';
  sizes: number[];
  index: number;
  onResize: (sizes: number[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; container: number; sizes: number[] } | null>(
    null,
  );
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    function onMove(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      const cur = dir === 'row' ? e.clientX : e.clientY;
      const deltaPct = ((cur - d.start) / d.container) * 100;
      let a = d.sizes[index] + deltaPct;
      let b = d.sizes[index + 1] - deltaPct;
      if (a < MIN_PERCENT) {
        b -= MIN_PERCENT - a;
        a = MIN_PERCENT;
      }
      if (b < MIN_PERCENT) {
        a -= MIN_PERCENT - b;
        b = MIN_PERCENT;
      }
      const next = [...d.sizes];
      next[index] = a;
      next[index + 1] = b;
      onResize(next);
    }
    function onUp() {
      setActive(false);
    }
    document.body.style.cursor = dir === 'row' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active, dir, index, onResize]);

  return (
    <div
      ref={ref}
      onMouseDown={(e) => {
        e.preventDefault();
        const parent = ref.current?.parentElement;
        const rect = parent?.getBoundingClientRect();
        if (!rect) return;
        drag.current = {
          start: dir === 'row' ? e.clientX : e.clientY,
          container: dir === 'row' ? rect.width : rect.height,
          sizes: [...sizes],
        };
        setActive(true);
      }}
      title="Drag to resize"
      className={`shrink-0 border-[var(--color-border)] hover:bg-[var(--color-accent)]/40 ${
        dir === 'row'
          ? 'w-1.5 cursor-ew-resize border-x'
          : 'h-1.5 cursor-ns-resize border-y'
      } ${active ? 'bg-[var(--color-accent)]/40' : ''}`}
    />
  );
}
