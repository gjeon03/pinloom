import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  label: string;
  side?: Side;
  children: ReactNode;
}

const VIEWPORT_MARGIN = 8;

export function Tooltip({ label, side = 'bottom', children }: Props) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  // `visible` flips on hover/focus.
  const [visible, setVisible] = useState(false);
  // `suppressed` hides the tooltip after a click until the user re-enters
  // the element. Without this, hovering after pressing the button would
  // keep the tooltip glued open even though the user already acted.
  const [suppressed, setSuppressed] = useState(false);
  // Computed page-space coords for the tooltip body. Position-fixed lets
  // us escape any ancestor `overflow: hidden|auto|scroll` (e.g. the tab
  // strip) which would otherwise clip the body to the parent's box.
  const [coords, setCoords] = useState<CSSProperties | null>(null);

  function recompute() {
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (!anchor || !tip) return;
    const aRect = anchor.getBoundingClientRect();
    const tRect = tip.getBoundingClientRect();
    const gap = 6;
    let top = 0;
    let left = 0;
    if (side === 'top') {
      top = aRect.top - tRect.height - gap;
      left = aRect.left + aRect.width / 2 - tRect.width / 2;
    } else if (side === 'bottom') {
      top = aRect.bottom + gap;
      left = aRect.left + aRect.width / 2 - tRect.width / 2;
    } else if (side === 'left') {
      top = aRect.top + aRect.height / 2 - tRect.height / 2;
      left = aRect.left - tRect.width - gap;
    } else {
      top = aRect.top + aRect.height / 2 - tRect.height / 2;
      left = aRect.right + gap;
    }
    // Clamp inside viewport
    const maxLeft = window.innerWidth - tRect.width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - tRect.height - VIEWPORT_MARGIN;
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(maxLeft, VIEWPORT_MARGIN));
    top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(maxTop, VIEWPORT_MARGIN));
    setCoords({ position: 'fixed', top, left });
  }

  // Reposition on every visibility flip and on viewport changes while
  // open. The scroll listener is in the capture phase so nested
  // scrollers (chat log, tab strip, etc.) all bubble through — but
  // that means a continuous wheel can fire it ~60Hz against forced
  // layout from getBoundingClientRect. rAF-coalesce to 1 reposition
  // per frame.
  useLayoutEffect(() => {
    if (!visible || suppressed) return;
    recompute();
    let rafId: number | null = null;
    function schedule() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        recompute();
      });
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, suppressed, side, label]);

  const showing = visible && !suppressed;

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={() => {
        setSuppressed(false);
        setVisible(true);
      }}
      onMouseLeave={() => {
        setVisible(false);
        setSuppressed(false);
      }}
      onMouseDown={() => setSuppressed(true)}
      onFocus={() => {
        if (!suppressed) setVisible(true);
      }}
      onBlur={() => setVisible(false)}
    >
      {children}
      {showing &&
        createPortal(
          <span
            ref={tooltipRef}
            role="tooltip"
            style={coords ?? { position: 'fixed', top: -9999, left: -9999 }}
            className="pointer-events-none z-[100] whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-0.5 text-[11px] text-[var(--color-ink)] shadow-lg"
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
