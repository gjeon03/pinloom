import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  left: ReactNode;
  right: ReactNode;
  storageKey?: string;
  minLeft?: number;
  minRight?: number;
}

export function HSplitter({
  left,
  right,
  storageKey,
  minLeft = 280,
  minRight = 400,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const saved = storageKey ? localStorage.getItem(storageKey) : null;
    if (saved) {
      setLeftWidth(Number(saved));
    } else {
      setLeftWidth(containerRef.current.getBoundingClientRect().width / 2);
    }
  }, [storageKey]);

  useEffect(() => {
    if (leftWidth == null || !storageKey) return;
    localStorage.setItem(storageKey, String(leftWidth));
  }, [leftWidth, storageKey]);

  useEffect(() => {
    if (!dragging) return;

    function onMove(e: MouseEvent) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const next = Math.max(
        minLeft,
        Math.min(rect.width - minRight, e.clientX - rect.left),
      );
      setLeftWidth(next);
    }

    function onUp() {
      setDragging(false);
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, minLeft, minRight]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      <div
        style={{ width: leftWidth ?? '50%' }}
        className="shrink-0 min-h-0 overflow-hidden"
      >
        {left}
      </div>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        className={`group w-1 shrink-0 cursor-col-resize relative ${
          dragging ? 'bg-[var(--color-accent)]' : ''
        }`}
      >
        <div
          className={`absolute inset-y-0 -left-1 w-3 ${
            dragging
              ? ''
              : 'group-hover:bg-[var(--color-accent)]/30 transition-colors'
          }`}
        />
      </div>
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">{right}</div>
    </div>
  );
}
