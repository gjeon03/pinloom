// Detect when something blocks the Node event loop for long enough to make
// fetch + WS handshakes pile up — better-sqlite3 is synchronous, so a single
// runaway query (or sync hot path that creeps into the runner) silently
// serializes every concurrent HTTP request behind it. Pure diagnostic: we
// only log; no behavior change. Keep it cheap (20ms resolution, 5s window).
//
// When the warning fires, the message includes mean / p99 / max in ms over
// the last window — large gap between p99 and max usually means one long
// stall rather than steady slowness.

import { monitorEventLoopDelay } from 'node:perf_hooks';

const RESOLUTION_MS = 20;
const WINDOW_MS = 5000;
const WARN_THRESHOLD_MS = 200;
// Suppress warnings during the first window after boot. Migrations, wiki
// sync warm-up, and any one-shot startup work can legitimately exceed
// the threshold without indicating a steady-state regression.
const BOOT_WARMUP_MS = 10_000;

export function startEventLoopMonitor(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const startedAt = Date.now();

  const interval = setInterval(() => {
    const maxMs = histogram.max / 1e6;
    const withinWarmup = Date.now() - startedAt < BOOT_WARMUP_MS;
    if (maxMs > WARN_THRESHOLD_MS && !withinWarmup) {
      const meanMs = histogram.mean / 1e6;
      const p99Ms = histogram.percentile(99) / 1e6;
      console.warn(
        `[event-loop] blocked ${maxMs.toFixed(0)}ms in last ${WINDOW_MS / 1000}s ` +
          `(mean ${meanMs.toFixed(1)}ms, p99 ${p99Ms.toFixed(1)}ms)`,
      );
    }
    histogram.reset();
  }, WINDOW_MS);
  interval.unref();

  return () => {
    clearInterval(interval);
    histogram.disable();
  };
}
