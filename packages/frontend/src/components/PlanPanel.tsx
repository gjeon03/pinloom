import { useMemo, useState } from 'react';
import type { Plan, PlanItem, PlanItemStatus } from '@planloom/shared';
import { PLAN_ITEM_STATUSES } from '@planloom/shared';
import { api } from '../api/client.js';

interface Props {
  plans: Plan[];
  activePlan: Plan | null;
  items: PlanItem[];
  onSelectPlan: (p: Plan) => void;
  onCreatePlan: (title: string) => void;
  onItemsChange: (items: PlanItem[]) => void;
}

const statusBadge: Record<PlanItemStatus, string> = {
  todo: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
  running: 'bg-yellow-500/20 text-yellow-300',
  done: 'bg-emerald-500/20 text-emerald-300',
  skipped: 'bg-neutral-500/20 text-neutral-300',
  blocked: 'bg-red-500/20 text-red-300',
};

interface TreeNode {
  item: PlanItem;
  children: TreeNode[];
}

function buildTree(items: PlanItem[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const item of items) byId.set(item.id, { item, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.item.parentId && byId.has(node.item.parentId)) {
      byId.get(node.item.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.item.orderIndex - b.item.orderIndex);
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

export function PlanPanel({
  plans,
  activePlan,
  items,
  onSelectPlan,
  onCreatePlan,
  onItemsChange,
}: Props) {
  const [newTitle, setNewTitle] = useState('');
  const [newPlanTitle, setNewPlanTitle] = useState('');
  const [subInputFor, setSubInputFor] = useState<string | null>(null);
  const [subTitle, setSubTitle] = useState('');

  const tree = useMemo(() => buildTree(items), [items]);

  async function addRootItem() {
    if (!activePlan || !newTitle.trim()) return;
    const item = await api.createPlanItem(activePlan.id, { title: newTitle.trim() });
    onItemsChange([...items, item]);
    setNewTitle('');
  }

  async function addSubItem(parentId: string) {
    if (!activePlan || !subTitle.trim()) return;
    const item = await api.createPlanItem(activePlan.id, {
      title: subTitle.trim(),
      parentId,
    });
    onItemsChange([...items, item]);
    setSubTitle('');
    setSubInputFor(null);
  }

  async function cycleStatus(item: PlanItem) {
    const next = nextStatus(item.status);
    const updated = await api.updatePlanItem(item.id, { status: next });
    onItemsChange(items.map((i) => (i.id === updated.id ? updated : i)));
  }

  function renderNode(node: TreeNode, depth: number) {
    const item = node.item;
    return (
      <div key={item.id} className="flex flex-col gap-1">
        <div
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm"
          style={{ marginLeft: depth * 12 }}
        >
          <div className="flex items-center gap-2">
            <button
              onClick={() => cycleStatus(item)}
              className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${statusBadge[item.status]}`}
            >
              {item.status}
            </button>
            <span className="flex-1">{item.title}</span>
            <button
              onClick={() => {
                setSubInputFor(subInputFor === item.id ? null : item.id);
                setSubTitle('');
              }}
              title="Add subtask"
              className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] px-1"
            >
              +
            </button>
          </div>
          {item.body && (
            <p className="mt-1 text-xs text-[var(--color-ink-muted)] whitespace-pre-wrap">
              {item.body}
            </p>
          )}
          {subInputFor === item.id && (
            <div className="mt-2 flex gap-1">
              <input
                autoFocus
                value={subTitle}
                onChange={(e) => setSubTitle(e.target.value)}
                placeholder="Subtask title"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addSubItem(item.id);
                  if (e.key === 'Escape') setSubInputFor(null);
                }}
                className="flex-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1 text-xs"
              />
              <button
                onClick={() => addSubItem(item.id)}
                disabled={!subTitle.trim()}
                className="rounded bg-[var(--color-accent)] text-black px-2 py-1 text-xs disabled:opacity-40"
              >
                Add
              </button>
            </div>
          )}
        </div>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <aside className="border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
      <div className="border-b border-[var(--color-border)] p-3 flex flex-col gap-2">
        <select
          value={activePlan?.id ?? ''}
          onChange={(e) => {
            const p = plans.find((p) => p.id === e.target.value);
            if (p) onSelectPlan(p);
          }}
          className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1.5 text-sm"
        >
          {plans.length === 0 && <option value="">No plans</option>}
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <input
            value={newPlanTitle}
            onChange={(e) => setNewPlanTitle(e.target.value)}
            placeholder="New plan title"
            className="flex-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1 text-xs"
          />
          <button
            className="rounded bg-[var(--color-accent)] text-black px-2 py-1 text-xs disabled:opacity-40"
            disabled={!newPlanTitle.trim()}
            onClick={() => {
              onCreatePlan(newPlanTitle.trim());
              setNewPlanTitle('');
            }}
          >
            +
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 flex flex-col gap-1.5">
        {tree.map((node) => renderNode(node, 0))}
        {activePlan && items.length === 0 && (
          <p className="text-xs text-[var(--color-ink-muted)]">No plan items yet.</p>
        )}
      </div>

      {activePlan && (
        <div className="border-t border-[var(--color-border)] p-3 flex gap-1">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add plan item"
            onKeyDown={(e) => e.key === 'Enter' && addRootItem()}
            className="flex-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1.5 text-sm"
          />
          <button
            onClick={addRootItem}
            className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={!newTitle.trim()}
          >
            Add
          </button>
        </div>
      )}
    </aside>
  );
}

function nextStatus(current: PlanItemStatus): PlanItemStatus {
  const i = PLAN_ITEM_STATUSES.indexOf(current);
  return PLAN_ITEM_STATUSES[(i + 1) % PLAN_ITEM_STATUSES.length];
}
