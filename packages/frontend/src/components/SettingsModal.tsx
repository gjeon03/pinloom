import { useEffect, useState } from 'react';
import type { HealthResponse } from '@pinloom/shared';
import { api } from '../api/client.js';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 cursor-default"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>

        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
            Claude Code CLI
          </h3>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {health && (
            <div className="text-sm">
              <p>
                Installed:{' '}
                <span
                  className={
                    health.cli.installed ? 'text-emerald-300' : 'text-red-400'
                  }
                >
                  {String(health.cli.installed)}
                </span>
              </p>
              {health.cli.version && (
                <p className="text-[var(--color-ink-muted)]">
                  Version: {health.cli.version}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
