import { type CSSProperties, useEffect, useState } from 'react';
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
        // The autocomplete="off" + 1password/lastpass opt-out attrs below
        // exist so browsers don't fire their "save password?" prompt when
        // the user is just typing an API token into a local-only tool.
        // We keep the value field as type="text" (not type="password") for
        // the same reason — Chrome treats password inputs as credential
        // material no matter what autocomplete says — and mask visually via
        // CSS instead.
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
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
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
              type="text"
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              placeholder="paste token here"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              style={
                draft.isSecret
                  ? ({ WebkitTextSecurity: 'disc' } as CSSProperties)
                  : undefined
              }
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
              autoComplete="off"
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

          <BackupSection />
        </div>
      </div>
    </div>
  );
}

// GitHub backup configuration. Phase A surfaces token + repo selection
// only; the Sync / Restore buttons (Phases B/C) will live in the same
// section once their backends land.
interface BackupConfig {
  connected: boolean;
  user: { login: string } | null;
  repo: { fullName: string; cloneUrl: string } | null;
  lastSyncAt: string | null;
}

interface BackupRepo {
  fullName: string;
  name: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string;
}

function BackupSection() {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [repos, setRepos] = useState<BackupRepo[] | null>(null);
  const [createName, setCreateName] = useState('pinloom-backup');
  const [mode, setMode] = useState<'select' | 'create'>('create');

  async function refresh() {
    try {
      setConfig(await api.getBackupConfig());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function saveToken() {
    if (tokenDraft.trim().length === 0) {
      setError('Token is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.setBackupToken(tokenDraft.trim());
      setConfig(next);
      setTokenDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.clearBackupToken();
      setConfig(next);
      setRepos(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadRepos() {
    setBusy(true);
    setError(null);
    try {
      setRepos(await api.listBackupRepos());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function selectRepo(r: BackupRepo) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setBackupRepo({
        mode: 'select',
        fullName: r.fullName,
        cloneUrl: r.cloneUrl,
      });
      setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createRepo() {
    const name = createName.trim();
    if (!name) {
      setError('Repo name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.setBackupRepo({
        mode: 'create',
        name,
        private: true,
      });
      setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        GitHub Backup
      </h3>
      {config === null ? (
        <p className="text-sm text-[var(--color-ink-muted)]">Loading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {!config.connected ? (
            <div className="space-y-2">
              <p className="text-[var(--color-ink-muted)]">
                Paste a GitHub Personal Access Token to enable backup of wikis
                and sessions to a private repository. Easiest path:{' '}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=pinloom-backup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-accent)] underline"
                >
                  generate a classic token with <code>repo</code> scope
                </a>
                . Fine-grained tokens work too but only if you give them{' '}
                <em>Administration: write</em> on <em>All repositories</em> —
                otherwise pinloom can read repos but cannot create new ones.
                The token is stored as-is in pinloom's local DB — anyone with
                the DB file effectively has the token, so revoke it on GitHub
                if the file leaks.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder="github_pat_..."
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={saveToken}
                  disabled={busy || tokenDraft.trim().length === 0}
                  className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  Connect
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[var(--color-ink-muted)]">
                    Connected as{' '}
                  </span>
                  <span className="font-medium">
                    {config.user?.login ?? '(unknown)'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busy}
                  className="text-xs text-[var(--color-ink-muted)] hover:text-red-400"
                >
                  Disconnect
                </button>
              </div>
              {config.repo ? (
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase text-[var(--color-ink-muted)]">
                      Backup repository
                    </div>
                    <div className="font-mono text-sm">{config.repo.fullName}</div>
                  </div>
                  <a
                    href={`https://github.com/${config.repo.fullName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--color-accent)] underline"
                  >
                    Open on GitHub
                  </a>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMode('create')}
                      className={`px-2 py-1 rounded text-xs ${
                        mode === 'create'
                          ? 'bg-[var(--color-accent)] text-black'
                          : 'border border-[var(--color-border)] text-[var(--color-ink-muted)]'
                      }`}
                    >
                      Create new
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('select');
                        if (repos === null) void loadRepos();
                      }}
                      className={`px-2 py-1 rounded text-xs ${
                        mode === 'select'
                          ? 'bg-[var(--color-accent)] text-black'
                          : 'border border-[var(--color-border)] text-[var(--color-ink-muted)]'
                      }`}
                    >
                      Select existing
                    </button>
                  </div>
                  {mode === 'create' ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={createName}
                        onChange={(e) => setCreateName(e.target.value)}
                        placeholder="pinloom-backup"
                        className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={createRepo}
                        disabled={busy || createName.trim().length === 0}
                        className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm disabled:opacity-40"
                      >
                        Create
                      </button>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-auto rounded border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                      {repos === null ? (
                        <p className="px-3 py-2 text-[var(--color-ink-muted)]">
                          Loading…
                        </p>
                      ) : repos.length === 0 ? (
                        <p className="px-3 py-2 text-[var(--color-ink-muted)]">
                          No repositories.
                        </p>
                      ) : (
                        repos.map((r) => (
                          <button
                            key={r.fullName}
                            type="button"
                            onClick={() => selectRepo(r)}
                            disabled={busy}
                            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--color-surface-3)] disabled:opacity-40"
                          >
                            <span className="font-mono">{r.fullName}</span>
                            {r.private && (
                              <span className="ml-2 text-[10px] uppercase text-[var(--color-ink-muted)]">
                                private
                              </span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              {config.lastSyncAt && (
                <div className="text-xs text-[var(--color-ink-muted)]">
                  Last sync: {new Date(config.lastSyncAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      )}
    </section>
  );
}
