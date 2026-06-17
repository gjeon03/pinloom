import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

// As an installed PWA the static shell loads from the service worker cache,
// so the window can open even when the backend (port 4748) isn't running —
// every `/api` call and WebSocket then fails silently. This banner polls
// `/api/health` and surfaces an explicit "backend is down" state so the user
// knows to start pinloom (or that login-autostart didn't fire) instead of
// staring at an app that quietly does nothing.
const POLL_MS = 5000;

export function BackendStatusBanner() {
  const [down, setDown] = useState(false);
  // Only flip to "down" after two consecutive misses so a single dropped
  // request (server busy on a synchronous query) doesn't flash the banner.
  const missesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          missesRef.current = 0;
          setDown(false);
        } else {
          bump();
        }
      } catch {
        if (cancelled) return;
        bump();
      } finally {
        if (!cancelled) timer = setTimeout(check, POLL_MS);
      }
    }

    function bump() {
      missesRef.current += 1;
      if (missesRef.current >= 2) setDown(true);
    }

    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!down) return null;

  return (
    <div
      role="alert"
      className="shrink-0 flex items-center justify-center gap-2 bg-[var(--color-error-bg)] text-[var(--color-error-ink)] border-b border-[var(--color-error-border)] px-3 py-1.5 text-xs"
    >
      <AlertTriangle size={14} />
      <span>
        Can’t reach the pinloom backend. Start it with{' '}
        <code className="font-mono">pnpm start</code> (or enable “Start at
        login” in Settings).
      </span>
    </div>
  );
}
