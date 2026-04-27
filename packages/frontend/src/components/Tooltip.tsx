import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  label: string;
  side?: Side;
  children: ReactNode;
}

const VIEWPORT_MARGIN = 8;

const POSITION: Record<Side, CSSProperties> = {
  top: { bottom: '100%', left: '50%', marginBottom: '6px' },
  bottom: { top: '100%', left: '50%', marginTop: '6px' },
  left: { right: '100%', top: '50%', marginRight: '6px' },
  right: { left: '100%', top: '50%', marginLeft: '6px' },
};

function transformFor(side: Side, dx: number, dy: number): string {
  if (side === 'top' || side === 'bottom') {
    return `translate(calc(-50% + ${dx}px), ${dy}px)`;
  }
  return `translate(${dx}px, calc(-50% + ${dy}px))`;
}

export function Tooltip({ label, side = 'bottom', children }: Props) {
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });

  function recompute() {
    const el = tooltipRef.current;
    if (!el) return;
    // Measure the natural (unshifted) position. We momentarily override the
    // applied transform so a stale shift from a previous hover doesn't make
    // the tooltip appear "already inside the viewport" and trick us.
    const previous = el.style.transform;
    el.style.transform = transformFor(side, 0, 0);
    const rect = el.getBoundingClientRect();
    el.style.transform = previous;

    let dx = 0;
    let dy = 0;
    if (rect.right > window.innerWidth - VIEWPORT_MARGIN) {
      dx = window.innerWidth - VIEWPORT_MARGIN - rect.right;
    } else if (rect.left < VIEWPORT_MARGIN) {
      dx = VIEWPORT_MARGIN - rect.left;
    }
    if (rect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
      dy = window.innerHeight - VIEWPORT_MARGIN - rect.bottom;
    } else if (rect.top < VIEWPORT_MARGIN) {
      dy = VIEWPORT_MARGIN - rect.top;
    }
    if (dx !== shift.x || dy !== shift.y) {
      setShift({ x: dx, y: dy });
    }
  }

  return (
    <span
      className="relative inline-flex group"
      onMouseEnter={recompute}
      onFocus={recompute}
    >
      {children}
      <span
        ref={tooltipRef}
        role="tooltip"
        style={{
          ...POSITION[side],
          transform: transformFor(side, shift.x, shift.y),
        }}
        className="pointer-events-none absolute z-50 whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-0.5 text-[11px] text-[var(--color-ink)] shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150"
      >
        {label}
      </span>
    </span>
  );
}
