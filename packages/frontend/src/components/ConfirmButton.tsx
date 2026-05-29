import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// A destructive-action button. When `needsConfirm` is true it pops a small
// Yes/No confirmation (rendered via portal so an ancestor's overflow can't
// clip it); otherwise it fires immediately. Used to guard deleting notepad
// tabs / panes that still hold text.
export function ConfirmButton({
  needsConfirm,
  message,
  onConfirm,
  title,
  className,
  children,
}: {
  needsConfirm: boolean;
  message: string;
  onConfirm: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setCoords({ top: r.bottom + 4, left: r.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          if (needsConfirm) setOpen((v) => !v);
          else onConfirm();
        }}
      >
        {children}
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              transform: 'translateX(-100%)',
            }}
            className="z-[100] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1.5 whitespace-nowrap text-[11px] text-[var(--color-ink)]">
              {message}
            </p>
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
                className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90"
              >
                Yes
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
