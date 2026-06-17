import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

// As an installed PWA the static shell loads from the service worker cache,
// so the window can open even when the backend (port 4748) isn't running —
// every `/api` call and WebSocket then fails silently. This banner surfaces an
// explicit "backend is down" state so the user knows to start pinloom (or that
// login-autostart didn't fire).
//
// We deliberately do NOT poll on a healthy backend — that would spam the
// request log for no benefit. The only moment the banner matters is when you
// open or return to the app, so we check once on mount and again whenever the
// tab becomes visible. While DOWN we re-check on a short timer so the banner
// clears itself once you start the backend; that loop stops the moment it's
// reachable again. The probe hits `/api/ping` (no work) rather than
// `/api/health` (which spawns `claude`/`codex --version`).
const RECOVER_MS = 4000; // while down: how often to re-check for recovery

export function BackendStatusBanner() {
  const [down, setDown] = useState(false);
  // Only flip to "down" after two consecutive misses so a single dropped
  // request (server busy on a synchronous query) doesn't flash the banner.
  const missesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      // Skip while backgrounded — nothing to show; we re-check on return.
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/ping', { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          // Healthy → clear and STOP. No timer is scheduled, so a running
          // backend is never polled; the next check is on focus/visibility.
          missesRef.current = 0;
          setDown(false);
        } else {
          bump();
        }
      } catch {
        if (!cancelled) bump();
      }
    }

    function bump() {
      missesRef.current += 1;
      if (missesRef.current >= 2) setDown(true);
      // Keep retrying ONLY while unreachable, so the banner auto-clears once
      // the backend comes back.
      clearTimeout(timer);
      timer = setTimeout(check, RECOVER_MS);
    }

    function onVisible() {
      if (document.visibilityState === 'visible') check();
    }

    document.addEventListener('visibilitychange', onVisible);
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
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
