import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type { HealthResponse, UserEnvVar } from '@pinloom/shared';
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

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DraftEnvVar {
  key: string;
  value: string;
  description: string;
  isSecret: boolean;
  // True when editing an existing key (so we lock the key field).
  editingExisting: boolean;
}

const emptyDraft: DraftEnvVar = {
  key: '',
  value: '',
  description: '',
  isSecret: true,
  editingExisting: false,
};

function EnvVarsSection() {
  const [items, setItems] = useState<UserEnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftEnvVar | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setItems(await api.listEnvVars());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function startEdit(v: UserEnvVar) {
    setError(null);
    setDraft({
      key: v.key,
      // We do NOT prefill value — user must paste it again. This avoids a
      // round-trip of secret material when the edit was triggered to update,
      // say, only the description.
      value: '',
      description: v.description ?? '',
      isSecret: v.isSecret,
      editingExisting: true,
    });
  }

  function startAdd() {
    setError(null);
    setDraft({ ...emptyDraft });
  }

  async function save() {
    if (!draft) return;
    if (!KEY_PATTERN.test(draft.key)) {
      setError('Key must match /^[A-Za-z_][A-Za-z0-9_]*$/');
      return;
    }
    if (draft.value.length === 0) {
      setError('Value cannot be empty');
      return;
    }
    setBusy(true);
    try {
      await api.upsertEnvVar(draft.key, {
        value: draft.value,
        description: draft.description || null,
        isSecret: draft.isSecret,
      });
      setDraft(null);
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    if (!confirm(`Delete ${key}?`)) return;
    setBusy(true);
    try {
      await api.deleteEnvVar(key);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
          Environment Variables
        </h3>
        {!draft && (
          <button
            onClick={startAdd}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-3)]"
          >
            <Plus size={12} />
            Add
          </button>
        )}
      </div>

      <p className="text-xs text-[var(--color-ink-muted)] mb-3">
        Stored locally. Exposed to every agent run as <code>$KEY</code> in
        Bash. Use for Asana / GitLab / Notion tokens, custom API base URLs,
        etc. Values never leave this machine.
      </p>

      {items === null && !error && (
        <p className="text-[var(--color-ink-muted)] text-sm">Loading…</p>
      )}

      {items && items.length === 0 && !draft && (
        <p className="text-[var(--color-ink-muted)] text-sm py-2">
          No variables configured yet.
        </p>
      )}

      {items && items.length > 0 && (
        <div className="border border-[var(--color-border)] rounded divide-y divide-[var(--color-border)]">
          {items.map((v) => (
            <div
              key={v.key}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs">{v.key}</div>
                {v.description && (
                  <div className="text-xs text-[var(--color-ink-muted)] truncate">
                    {v.description}
                  </div>
                )}
              </div>
              <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                {v.isSecret ? '••••••••' : 'plain'}
              </span>
              <button
                onClick={() => startEdit(v)}
                className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
                title="Edit"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => remove(v.key)}
                className="text-[var(--color-ink-muted)] hover:text-red-400 p-1 rounded hover:bg-[var(--color-surface-3)]"
                title="Delete"
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mt-3 border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface-3)] space-y-2">
          <div>
            <label className="text-xs text-[var(--color-ink-muted)] block mb-1">
              Key
            </label>
            <input
              autoFocus={!draft.editingExisting}
              value={draft.key}
              disabled={draft.editingExisting}
              onChange={(e) =>
                setDraft({ ...draft, key: e.target.value.trim() })
              }
              placeholder="ASANA_TOKEN"
              className="w-full px-2 py-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-mono disabled:opacity-60"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--color-ink-muted)] block mb-1">
              Value
              {draft.editingExisting && (
                <span className="ml-1 text-[10px]">
                  (paste again to overwrite)
                </span>
              )}
            </label>
            <input
              autoFocus={draft.editingExisting}
              type={draft.isSecret ? 'password' : 'text'}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              placeholder="paste token here"
              className="w-full px-2 py-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--color-ink-muted)] block mb-1">
              Description (optional)
            </label>
            <input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="e.g. Asana personal access token"
              className="w-full px-2 py-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
            <input
              type="checkbox"
              checked={draft.isSecret}
              onChange={(e) =>
                setDraft({ ...draft, isSecret: e.target.checked })
              }
            />
            Treat as secret (mask in UI)
          </label>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              disabled={busy}
              className="px-3 py-1 rounded text-xs border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="px-3 py-1 rounded text-xs bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {error && !draft && (
        <p className="text-red-400 text-xs mt-2">{error}</p>
      )}
    </section>
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
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 cursor-default"
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

        <div className="space-y-6">
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

          <EnvVarsSection />
        </div>
      </div>
    </div>
  );
}
