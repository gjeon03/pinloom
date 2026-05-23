import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Plan, PlanItem, PlanItemStatus } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface Props {
  projectId: string;
}

// MVP UX:
//   - One plan selector at the top (most projects will only have one).
//   - Tree view of plan items, indented by parentId chain.
//   - Title is inline-editable on click. Body is hidden behind a toggle
//     so the tree stays scannable.
//   - Status pill cycles through the five values on click.
//   - "+ Add child" inline beneath each item, "+ Add top-level" in the
//     plan header.
//   - WS subscription keeps the tree fresh against agent updates and
//     other browser windows.

const STATUS_CYCLE: PlanItemStatus[] = [
  'todo',
  'running',
  'done',
  'skipped',
  'blocked',
];

const STATUS_COLORS: Record<PlanItemStatus, string> = {
  todo: 'border-[var(--color-border)] text-[var(--color-ink-muted)] bg-[var(--color-surface-3)]',
  running:
    'border-blue-400/40 text-blue-300 bg-blue-500/10',
  done: 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10',
  skipped:
    'border-zinc-500/40 text-zinc-400 bg-zinc-500/10 line-through opacity-80',
  blocked:
    'border-red-400/40 text-red-300 bg-red-500/10',
};

function nextStatus(s: PlanItemStatus): PlanItemStatus {
  const i = STATUS_CYCLE.indexOf(s);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
}

interface TreeNode {
  item: PlanItem;
  children: TreeNode[];
}

function buildTree(items: PlanItem[]): TreeNode[] {
  const byParent = new Map<string | null, PlanItem[]>();
  for (const it of items) {
    const key = it.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(it);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.orderIndex - b.orderIndex);
  }
  function buildNode(it: PlanItem): TreeNode {
    return {
      item: it,
      children: (byParent.get(it.id) ?? []).map(buildNode),
    };
  }
  return (byParent.get(null) ?? []).map(buildNode);
}

export function PlanPanel({ projectId }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const ps = await api.listPlans(projectId);
      setPlans(ps);
      if (ps.length === 0) {
        setActivePlanId(null);
        setItems([]);
      } else {
        // Keep current selection if still present, otherwise fall back
        // to the most recent plan.
        const stillThere = activePlanId
          ? ps.find((p) => p.id === activePlanId) ?? null
          : null;
        const next = stillThere ?? ps[0];
        setActivePlanId(next.id);
        const its = await api.listPlanItems(next.id);
        setItems(its);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!activePlanId) return;
    let cancelled = false;
    api.listPlanItems(activePlanId).then((its) => {
      if (!cancelled) setItems(its);
    }).catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [activePlanId]);

  // Live updates — plan_item_updated covers both create + edit (the
  // backend broadcasts on both). We merge by id so concurrent agent
  // runs in another worker session reflect immediately.
  useWebSocket(activePlanId ? `plan:${activePlanId}` : null, (ev) => {
    if (ev.type !== 'plan_item_updated' || ev.planId !== activePlanId) return;
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.id === ev.item.id);
      if (idx === -1) return [...prev, ev.item];
      const next = prev.slice();
      next[idx] = ev.item;
      return next;
    });
  });

  const tree = useMemo(() => buildTree(items), [items]);

  async function handleCreatePlan() {
    const title = window.prompt('New plan title:');
    if (!title || !title.trim()) return;
    try {
      const p = await api.createPlan(projectId, { title: title.trim() });
      setPlans((prev) => [p, ...prev]);
      setActivePlanId(p.id);
      setItems([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleAddItem(parentId: string | null) {
    if (!activePlanId) return;
    const title = window.prompt(
      parentId ? 'New sub-item title:' : 'New plan item title:',
    );
    if (!title || !title.trim()) return;
    try {
      const it = await api.createPlanItem(activePlanId, {
        title: title.trim(),
        parentId,
      });
      // WS will also push the same item; merge guards against dup keys.
      setItems((prev) =>
        prev.some((p) => p.id === it.id) ? prev : [...prev, it],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleUpdate(
    itemId: string,
    body: Partial<Pick<PlanItem, 'title' | 'body' | 'status'>>,
  ) {
    try {
      const updated = await api.updatePlanItem(itemId, body);
      setItems((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(itemId: string) {
    if (
      !window.confirm(
        'Delete this plan item and all its sub-items? This cannot be undone.',
      )
    ) {
      return;
    }
    try {
      await api.deletePlanItem(itemId);
      // Local cascade: the backend cascades on parent_id via ON DELETE
      // CASCADE; mirror the same in the local state so the UI doesn't
      // briefly show orphans.
      setItems((prev) => {
        const dropped = new Set<string>();
        function markRecursive(id: string) {
          dropped.add(id);
          for (const child of prev.filter((p) => p.parentId === id)) {
            markRecursive(child.id);
          }
        }
        markRecursive(itemId);
        return prev.filter((p) => !dropped.has(p.id));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            Plan
          </span>
          {plans.length > 0 && (
            <select
              value={activePlanId ?? ''}
              onChange={(e) => setActivePlanId(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm max-w-[260px]"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCreatePlan}
            className="text-xs rounded border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)]"
          >
            New plan
          </button>
          {activePlanId && (
            <button
              type="button"
              onClick={() => handleAddItem(null)}
              className="text-xs rounded bg-[var(--color-accent)] text-black font-medium px-2 py-1 flex items-center gap-1"
            >
              <Plus size={12} />
              Top-level item
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="border-b border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-4 py-1.5 text-[11px] text-[var(--color-error-ink)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <p className="text-sm text-[var(--color-ink-muted)]">Loading…</p>
        ) : plans.length === 0 ? (
          <EmptyState onCreate={handleCreatePlan} />
        ) : items.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">
            No items yet. Click <strong>Top-level item</strong> to start
            building the plan.
          </p>
        ) : (
          <ul className="space-y-1">
            {tree.map((node) => (
              <PlanItemNode
                key={node.item.id}
                node={node}
                depth={0}
                onAddChild={(parentId) => handleAddItem(parentId)}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="max-w-md mx-auto mt-12 text-center text-sm text-[var(--color-ink-muted)]">
      <p className="mb-2">No plans yet for this project.</p>
      <p className="mb-4">
        A plan is a hierarchical to-do tree that this project's AI sessions
        can read on every turn. Items are referenceable in chat as{' '}
        <code>@itemId</code>.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm font-medium"
      >
        Create the first plan
      </button>
    </div>
  );
}

function PlanItemNode({
  node,
  depth,
  onAddChild,
  onUpdate,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  onAddChild: (parentId: string) => void;
  onUpdate: (
    itemId: string,
    body: Partial<Pick<PlanItem, 'title' | 'body' | 'status'>>,
  ) => void;
  onDelete: (itemId: string) => void;
}) {
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (titleDraft !== null) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [titleDraft]);

  const hasChildren = node.children.length > 0;
  const it = node.item;

  function commitTitle() {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (next.length === 0 || next === it.title) return;
    onUpdate(it.id, { title: next });
  }

  function commitBody() {
    if (bodyDraft === null) return;
    const next = bodyDraft;
    setBodyDraft(null);
    setBodyOpen(true);
    if (next === it.body) return;
    onUpdate(it.id, { body: next });
  }

  return (
    <li>
      <div
        className="group flex items-start gap-1.5 py-1 hover:bg-[var(--color-surface-2)]/40 rounded"
        style={{ paddingLeft: depth * 16 }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          disabled={!hasChildren}
          className="mt-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] disabled:opacity-30 disabled:cursor-default"
          aria-label={collapsed ? 'Expand children' : 'Collapse children'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        <button
          type="button"
          onClick={() => onUpdate(it.id, { status: nextStatus(it.status) })}
          title={`Status: ${it.status} — click to advance`}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-mono min-w-[64px] text-center ${STATUS_COLORS[it.status]}`}
        >
          {it.status}
        </button>

        <div className="flex-1 min-w-0">
          {titleDraft !== null ? (
            <input
              ref={titleInputRef}
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTitleDraft(null);
                }
              }}
              className="w-full bg-[var(--color-surface-2)] border border-[var(--color-accent)] rounded px-1.5 py-0.5 text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setTitleDraft(it.title)}
              className="text-sm text-left w-full truncate hover:text-[var(--color-accent)]"
              title="Click to edit"
            >
              {it.title}
            </button>
          )}
          {it.body.length > 0 && !bodyOpen && (
            <button
              type="button"
              onClick={() => setBodyOpen(true)}
              className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] line-clamp-1"
            >
              {it.body.split('\n')[0]}
            </button>
          )}
          {bodyOpen && (
            <div className="mt-1">
              {bodyDraft !== null ? (
                <textarea
                  value={bodyDraft}
                  autoFocus
                  onChange={(e) => setBodyDraft(e.target.value)}
                  onBlur={commitBody}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setBodyDraft(null);
                    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      commitBody();
                    }
                  }}
                  rows={3}
                  className="w-full rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setBodyDraft(it.body)}
                  className="text-xs text-[var(--color-ink)]/80 hover:text-[var(--color-accent)] whitespace-pre-wrap text-left w-full block"
                >
                  {it.body.length > 0 ? it.body : '(no body — click to add)'}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onAddChild(it.id)}
            title="Add sub-item"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            onClick={() => setBodyOpen((v) => !v)}
            title={bodyOpen ? 'Hide notes' : 'Show notes'}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] text-[10px] uppercase tracking-wide px-1"
          >
            notes
          </button>
          <button
            type="button"
            onClick={() => onDelete(it.id)}
            title="Delete"
            className="text-[var(--color-ink-muted)] hover:text-red-400 p-1"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {!collapsed && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <PlanItemNode
              key={child.item.id}
              node={child}
              depth={depth + 1}
              onAddChild={onAddChild}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
