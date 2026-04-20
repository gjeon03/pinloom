import { useEffect, useState } from 'react';
import type { HealthResponse } from '@planloom/shared';
import { api } from '../api/client.js';

export function SettingsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-4">Settings</h1>

      <section className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <h2 className="text-sm font-medium mb-2">Claude Code CLI</h2>
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
              <p className="text-[var(--color-ink-muted)]">Version: {health.cli.version}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
