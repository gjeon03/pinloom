import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { HealthResponse } from '@pinloom/shared';
import { api } from '../api/client.js';

type CliStatus = HealthResponse['agents']['claude'];

function CliRow({ label, status }: { label: string; status: CliStatus }) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-sm">{label}</span>
      <span className="text-sm flex items-baseline gap-2">
        <span
          className={
            status.installed ? 'text-emerald-300' : 'text-red-400'
          }
        >
          {status.installed ? 'installed' : 'not found'}
        </span>
        {status.version && (
          <span className="text-[var(--color-ink-muted)] text-xs">
            {status.version}
          </span>
        )}
      </span>
    </div>
  );
}

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
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={16} />
          </button>
        </div>

        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
            Agent CLIs
          </h3>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {!error && !health && (
            <p className="text-[var(--color-ink-muted)] text-sm">Checking…</p>
          )}
          {health && (
            <div className="divide-y divide-[var(--color-border)]">
              <CliRow label="Claude Code" status={health.agents.claude} />
              <CliRow label="Codex" status={health.agents.codex} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
