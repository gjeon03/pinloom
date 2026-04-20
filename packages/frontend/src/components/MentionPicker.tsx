import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanItem } from '@planloom/shared';

interface Props {
  items: PlanItem[];
  query: string;
  onSelect: (item: PlanItem) => void;
  onClose: () => void;
}

export function MentionPicker({ items, query, onSelect, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return items
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.id.startsWith(q))
      .slice(0, 6);
  }, [items, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        onSelect(filtered[index]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [filtered, index, onSelect, onClose]);

  if (filtered.length === 0) {
    return (
      <div
        ref={ref}
        className="absolute bottom-full left-0 mb-1 w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-xs text-[var(--color-ink-muted)] shadow-lg"
      >
        No plan items match.
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-lg overflow-hidden"
    >
      {filtered.map((item, i) => (
        <button
          key={item.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
          onMouseEnter={() => setIndex(i)}
          className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${
            i === index
              ? 'bg-[var(--color-surface-3)]'
              : 'bg-transparent hover:bg-[var(--color-surface-3)]'
          }`}
        >
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] w-12 shrink-0">
            {item.status}
          </span>
          <span className="flex-1 truncate">{item.title}</span>
          <span className="text-[10px] text-[var(--color-ink-muted)] font-mono">
            {item.id.slice(0, 6)}
          </span>
        </button>
      ))}
    </div>
  );
}
