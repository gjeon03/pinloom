import { type CSSProperties, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { GithubLink } from './GithubLink.js';
import type {
  HealthResponse,
  PromptTemplate,
  UserEnvVar,
} from '@pinloom/shared';
import useSWR from 'swr';
import { api, type AutostartStatus } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { usePwaInstall } from '../hooks/usePwaInstall.js';

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

function UserProfileSection() {
  const [text, setText] = useState<string | null>(null);
  const [maxChars, setMaxChars] = useState(4000);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserProfile()
      .then((r) => {
        setText(r.profile);
        setMaxChars(r.maxChars);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function save() {
    if (text === null) return;
    setSaving(true);
    setError(null);
    try {
      await api.setUserProfile(text);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        About You
      </h3>
      <p className="text-xs text-[var(--color-ink-muted)] mb-3">
        Your preferences and working style — included in <strong>every</strong>{' '}
        agent's system prompt, across all projects (distinct from the
        project-scoped wiki). Stored locally at{' '}
        <code>~/.pinloom/wiki/USER.md</code>;{' '}
        <strong>it is sent to the model on every turn</strong>, so keep it
        concise and free of secrets.
      </p>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      {text === null ? (
        <p className="text-[var(--color-ink-muted)] text-sm">Loading…</p>
      ) : (
        <>
          <textarea
            value={text}
            maxLength={maxChars}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. I prefer pnpm + TypeScript strict. Conventional commits. Be terse. Ask before large refactors."
            rows={6}
            className="w-full text-sm px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] resize-y"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] tabular-nums text-[var(--color-ink-muted)]">
              {text.length}/{maxChars}
            </span>
            <button
              onClick={save}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
            </button>
          </div>
        </>
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
        role="dialog"
        aria-label="Settings"
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 cursor-default"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
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

          <DefaultTransportSection />

          <EmbeddingsSection />

          <InstallAppSection />

          <AutostartSection />

          <EnvVarsSection />

          <UserProfileSection />

          <BackupSection />

          <DatabaseFileSection />

          <div className="pt-2 border-t border-[var(--color-border)]">
            <GithubLink />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Default transport for NEW sessions. SDK = structured ChatView; Terminal =
// live claude/codex TUI. Per-session conversion (tab menu) is independent;
// this only sets what a freshly-created session starts as. The session pins
// its transport at creation, so changing this never alters existing sessions.
function DefaultTransportSection() {
  const [setting, setSetting] = useState<'sdk' | 'terminal' | null>(null);
  const [effective, setEffective] = useState<string>('sdk');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getDefaultTransport()
      .then((r) => {
        setSetting(r.setting);
        setEffective(r.effective);
        setLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
  }, []);

  // The dropdown's selected value: the explicit setting, or 'env' (follow
  // PINLOOM_CLAUDE_TRANSPORT / default) when none is set.
  const selected = setting ?? 'env';

  async function change(next: string) {
    setBusy(true);
    setError(null);
    try {
      const body =
        next === 'env' ? null : (next as 'sdk' | 'terminal');
      const r = await api.setDefaultTransport(body);
      setSetting(r.setting);
      setEffective(r.effective);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        New-session mode
      </h3>
      {!loaded ? (
        <p className="text-[var(--color-ink-muted)] text-sm">Loading…</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => void change(e.target.value)}
              className="px-2 py-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm disabled:opacity-60"
            >
              <option value="sdk">SDK — structured chat</option>
              <option value="terminal">Terminal — live agent TUI</option>
              <option value="env">Follow environment / default</option>
            </select>
            <span className="text-xs text-[var(--color-ink-muted)]">
              now: <span className="font-mono">{effective}</span>
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            Applies to sessions you create from here on (claude + codex).
            Existing sessions keep their mode; switch any one from its tab’s
            ⋮ menu. “Follow environment” defers to PINLOOM_CLAUDE_TRANSPORT.
          </p>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      )}
    </section>
  );
}

// Install pinloom as a standalone PWA so it gets a dock/taskbar icon and its
// own window (no browser chrome). The service worker only precaches the static
// Which backend powers semantic search (⌘K + Recap). Live toggle: switching
// persists the choice, re-warms, and re-embeds the corpus in the background.
// Ollama is managed in-place (detect server, download the model with progress)
// — only installing the Ollama app itself is left to the user.
const EMB_MODES = [
  { id: 'in-process', label: 'In-process' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'off', label: 'Off' },
] as const;

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function EmbeddingsSection() {
  const { data, mutate } = useSWR('settings:embeddings', () => api.getEmbeddingsStatus(), {
    refreshInterval: 4000,
  });
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [pull, setPull] = useState<Awaited<ReturnType<typeof api.ollamaPullStatus>> | null>(null);

  async function setMode(mode: 'in-process' | 'ollama' | 'off') {
    if (busy || mode === data?.mode) return;
    setBusy(true);
    try {
      await api.setEmbeddingsBackend(mode);
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!data) return;
    await api.pullOllamaModel(data.ollamaModel);
    const iv = setInterval(async () => {
      const s = await api.ollamaPullStatus();
      setPull(s);
      if (!s.pulling) {
        clearInterval(iv);
        setPull(null);
        if (s.done) await api.setEmbeddingsBackend('ollama'); // re-warm against the now-present model
        await mutate();
      }
    }, 1000);
  }

  const mode = data?.mode ?? 'in-process';
  const pct = pull && pull.total > 0 ? Math.floor((pull.completed / pull.total) * 100) : 0;

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Search embeddings
      </h3>
      <p className="mb-2 text-xs text-[var(--color-ink-muted)]">
        Powers semantic ⌘K search + Recap. Ollama gives stronger embeddings (esp. Korean);
        switching re-embeds in the background (keyword-only meanwhile).
      </p>
      <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs w-fit">
        {EMB_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => void setMode(m.id)}
            disabled={busy}
            className={`px-3 py-1.5 ${
              mode === m.id
                ? 'bg-[var(--color-accent)] text-black'
                : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
            } disabled:opacity-50`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="mt-2 text-xs">
        {mode === 'off' && <span className="text-[var(--color-ink-muted)]">Keyword search only.</span>}
        {mode === 'in-process' && (
          <span className="text-[var(--color-ink-muted)]">
            {data?.ready ? `✓ ready (${data.id})` : 'warming up…'}
          </span>
        )}
        {mode === 'ollama' && data && (
          <>
            {!data.ollama.running ? (
              <div className="text-[var(--color-ink-muted)]">
                Ollama isn’t reachable. Already installed? It just needs to be{' '}
                <em>started</em>.{' '}
                <button
                  onClick={() => setGuideOpen(true)}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  Setup guide →
                </button>
              </div>
            ) : pull ? (
              <div className="text-[var(--color-ink-muted)]">
                Downloading {data.ollamaModel}… {pull.status} {pct > 0 ? `${pct}%` : ''}
                <div className="mt-1 h-1.5 w-full max-w-xs rounded bg-[var(--color-surface-3)]">
                  <div className="h-full rounded bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                </div>
              </div>
            ) : !data.modelPresent ? (
              <button
                onClick={() => void download()}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1 hover:border-[var(--color-accent)]"
              >
                Download {data.ollamaModel}
              </button>
            ) : (
              <span className="text-[var(--color-ink-muted)]">
                {data.ready ? `✓ ${data.id} ready` : 're-embedding corpus… (keyword search meanwhile)'}
              </span>
            )}
          </>
        )}
      </div>

      {data?.indexing && mode !== 'off' && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-[11px]">
          <div className="text-[var(--color-ink-muted)]">
            Indexed: messages {fmtCount(data.indexing.messages.indexed)}/
            {fmtCount(data.indexing.messages.total)} · timeline {data.indexing.timeline.indexed} · wiki{' '}
            {data.indexing.wiki.indexed}/{data.indexing.wiki.total}
            {data.indexing.messages.indexed < data.indexing.messages.total && !data.indexing.lastError && (
              <span className="ml-1 text-[var(--color-accent)]">· indexing…</span>
            )}
          </div>
          {data.indexing.lastError && (
            <div className="mt-1 text-amber-500">
              ⚠ last error ({data.indexing.lastError.pass}): {data.indexing.lastError.message}
              <span className="ml-1 text-[var(--color-ink-muted)]">
                · {timeAgo(data.indexing.lastError.at)}
              </span>
            </div>
          )}
        </div>
      )}
      {guideOpen && (
        <OllamaGuideModal model={data?.ollamaModel ?? 'bge-m3'} onClose={() => setGuideOpen(false)} />
      )}
    </section>
  );
}

// Compact, self-contained "how to get Ollama running" guide. The one thing
// pinloom can't do for the user is install + start a system daemon, so this
// covers exactly that (install → start → back here). Renders above the Settings
// modal. The most common trap: `brew install ollama` installs the binary but
// does NOT start the server, so the status stays "not reachable" until `ollama
// serve` (or the app) is running — step 2 calls that out explicitly.
function OllamaCmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(children).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {
            /* clipboard blocked — selection still works */
          },
        );
      }}
      title="Copy"
      className="group inline-flex items-center gap-1.5 rounded bg-[var(--color-surface-3)] px-2 py-1 font-mono text-xs hover:ring-1 hover:ring-[var(--color-accent)]"
    >
      <span>{children}</span>
      <span className="text-[10px] text-[var(--color-ink-muted)] group-hover:text-[var(--color-accent)]">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}

function OllamaGuideModal({ model, onClose }: { model: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Ollama setup guide"
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 text-sm"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Use Ollama for embeddings</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
          >
            <X size={16} />
          </button>
        </div>

        <ol className="space-y-3">
          <li>
            <div className="font-medium">1. Install (once)</div>
            <div className="mt-1 text-[var(--color-ink-muted)]">
              macOS: <OllamaCmd>brew install ollama</OllamaCmd> — or download from{' '}
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                ollama.com
              </a>
              .
            </div>
          </li>
          <li>
            <div className="font-medium">2. Start the server</div>
            <div className="mt-1 text-[var(--color-ink-muted)]">
              Installing alone isn’t enough — the server must run. Either run{' '}
              <OllamaCmd>ollama serve</OllamaCmd> in a terminal, or open the{' '}
              <strong>Ollama app</strong> (menu-bar icon). To keep it always on:{' '}
              <OllamaCmd>brew services start ollama</OllamaCmd>.
            </div>
          </li>
          <li>
            <div className="font-medium">3. Back here</div>
            <div className="mt-1 text-[var(--color-ink-muted)]">
              This panel auto-detects it within a few seconds, then a{' '}
              <strong>Download {model}</strong> button appears — click it and pinloom pulls the
              model (with a progress bar) and re-embeds in the background.
            </div>
          </li>
        </ol>

        <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-ink-muted)]">
          pinloom checks <code>http://localhost:11434</code>. Running Ollama on another host or
          port? Set <code>PINLOOM_OLLAMA_URL</code> and restart the backend.
        </p>
      </div>
    </div>
  );
}

// shell — the app still needs the backend running, which pairs with the
// login-autostart setting. Chromium fires `beforeinstallprompt` (button drives
// the native dialog); iOS Safari has no programmatic prompt, so we fall back to
// the manual "Add to Home Screen" instructions.
function InstallAppSection() {
  const { canInstall, isInstalled, isIos, promptInstall } = usePwaInstall();

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Install as app
      </h3>
      <div className="space-y-2 text-sm">
        {isInstalled ? (
          <p className="text-[var(--color-ink-muted)]">
            pinloom is running as an installed app. Pair this with “Start at
            login” below so the backend is always up when you open it.
          </p>
        ) : canInstall ? (
          <>
            <p className="text-[var(--color-ink-muted)]">
              Install pinloom as a desktop app — its own window with a
              dock/taskbar icon, no browser tabs.
            </p>
            <button
              type="button"
              onClick={() => void promptInstall()}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm"
            >
              <Download size={14} />
              Install pinloom
            </button>
          </>
        ) : isIos ? (
          <p className="text-[var(--color-ink-muted)]">
            On iOS Safari, tap the <strong>Share</strong> button, then{' '}
            <strong>Add to Home Screen</strong> to install pinloom as an app.
          </p>
        ) : (
          <p className="text-[var(--color-ink-muted)]">
            Installation isn’t available in this browser right now. In
            Chrome/Edge, look for the install icon in the address bar; if it’s
            missing, the app may already be installed or the browser doesn’t
            support it.
          </p>
        )}
      </div>
    </section>
  );
}

// Login autostart — register pinloom to launch at login so an installed PWA
// always opens to a live backend. macOS/Linux only; the source of truth is the
// OS (the server re-queries launchctl/systemctl on every GET), so the toggle
// reflects out-of-band changes. Unsupported platforms get a manual unit-file
// download instead.
function AutostartSection() {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    api
      .getAutostart()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const result = next
        ? await api.enableAutostart()
        : await api.disableAutostart();
      setStatus(result.status);
      setWarnings(result.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function downloadUnit() {
    const a = document.createElement('a');
    a.href = api.autostartUnitUrl();
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const platformLabel =
    status?.platform === 'darwin'
      ? 'macOS (LaunchAgent)'
      : status?.platform === 'linux'
        ? 'Linux (systemd --user)'
        : 'this platform';

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Start at login
      </h3>
      {status === null && !error ? (
        <p className="text-[var(--color-ink-muted)] text-sm">Loading…</p>
      ) : status && status.supported ? (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={status.installed}
              disabled={busy}
              onChange={(e) => void toggle(e.target.checked)}
            />
            <span>
              Launch pinloom automatically when you log in ({platformLabel})
            </span>
          </label>
          <p className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            Runs <code>pnpm start:served</code> from a login shell — it serves
            the current build (no rebuild). After pulling new code, run{' '}
            <code>pnpm build</code> to refresh it. Toggle off to remove the
            agent completely.
          </p>
          {status.installed && !status.registered && (
            <p className="text-amber-400 text-xs">
              The unit file exists but the OS doesn’t report it as loaded — try
              toggling off and on again.
            </p>
          )}
          {warnings.length > 0 && (
            <p className="text-amber-400 text-xs">{warnings.join(' ')}</p>
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-[var(--color-ink-muted)]">
            Automatic login start isn’t supported on {platformLabel} yet. You
            can download the launcher unit and install it manually.
          </p>
          <button
            type="button"
            onClick={downloadUnit}
            className="rounded border border-[var(--color-border)] text-sm px-3 py-1.5 hover:border-[var(--color-accent)]"
          >
            Download launcher file
          </button>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      )}
    </section>
  );
}

// Session DB backup is decoupled from the GitHub repo — the operator
// downloads a single JSON file and stores it wherever they want (USB,
// Dropbox, iCloud) and uploads it back into pinloom on the other
// machine to restore. Existing projects/sessions in the target DB are
// preserved by id-based skip-if-exists, so a repeated import is a
// no-op.
function DatabaseFileSection() {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    projectsImported: number;
    sessionsImported: number;
    messagesImported: number;
    projectsSkipped: number;
    sessionsSkipped: number;
  } | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  function download() {
    // Anchor click instead of fetch+Blob — letting the browser handle
    // Content-Disposition keeps memory usage flat on big exports and
    // gives us the right filename for free.
    const a = document.createElement('a');
    a.href = api.exportDbUrl();
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function upload(file: File) {
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      const summary = await api.importDb(text);
      setResult(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      // Force the file input to remount so re-importing the same file
      // works (browsers don't fire onChange when the same path is
      // re-picked).
      setFileInputKey((k) => k + 1);
    }
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Database file
      </h3>
      <div className="space-y-2 text-sm">
        <p className="text-[var(--color-ink-muted)]">
          Save your projects, sessions and messages as a single JSON file you
          can keep anywhere. On another machine, upload that file to merge it
          into the local DB. Existing project/session ids are skipped, so
          re-importing the same file is a no-op.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={download}
            className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm"
          >
            Download backup
          </button>
          <label
            className={`rounded border border-[var(--color-border)] text-sm px-3 py-1.5 hover:border-[var(--color-accent)] cursor-pointer ${
              importing ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {importing ? 'Importing…' : 'Upload backup…'}
            <input
              key={fileInputKey}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          {result && !importing && (
            <span className="text-xs text-[var(--color-ink-muted)]">
              Imported {result.projectsImported} project(s),{' '}
              {result.sessionsImported} session(s),{' '}
              {result.messagesImported} message(s)
              {result.projectsSkipped + result.sessionsSkipped > 0 && (
                <>
                  {' '}(skipped {result.projectsSkipped} existing project(s),{' '}
                  {result.sessionsSkipped} existing session(s))
                </>
              )}
              .
            </span>
          )}
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </section>
  );
}

// GitHub-backed wiki sync. Token + repo come from this section; the
// db-export path uses the same plumbing but is presented as a file
// operation rather than a git operation.
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
  const [createName, setCreateName] = useState('pinloom-wiki');
  const [mode, setMode] = useState<'select' | 'create'>('create');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    wikiBytes: number;
    committed: boolean;
    pushed: boolean;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{
    wikiFilesImported: number;
  } | null>(null);

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

  async function syncNow() {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const result = await api.runBackupSync();
      setSyncResult({
        wikiBytes: result.exported.wikiBytes,
        committed: result.committed,
        pushed: result.pushed,
      });
      // Refresh the config so the lastSyncAt label updates.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function restoreNow() {
    if (
      !window.confirm(
        'Pull wiki pages from the backup repo? Existing pages in pinloom will be left untouched — only files missing locally will be added.',
      )
    ) {
      return;
    }
    setRestoring(true);
    setError(null);
    setRestoreResult(null);
    try {
      const result = await api.runBackupRestore();
      setRestoreResult({
        wikiFilesImported: result.imported.wikiFilesImported,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Wiki sync (GitHub)
      </h3>
      {config === null ? (
        <p className="text-sm text-[var(--color-ink-muted)]">Loading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {!config.connected ? (
            <div className="space-y-2">
              <p className="text-[var(--color-ink-muted)]">
                Paste a GitHub Personal Access Token to back up your wiki tree
                to a private repository. Either token type works:
              </p>
              <ul className="text-[var(--color-ink-muted)] text-xs list-disc pl-5 space-y-1">
                <li>
                  <strong>Classic</strong> (<code>ghp_…</code>) — easiest;{' '}
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo&description=pinloom-wiki"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-accent)] underline"
                  >
                    generate with <code>repo</code> scope
                  </a>{' '}
                  and pinloom can both read and create repos.
                </li>
                <li>
                  <strong>Fine-grained</strong> (<code>github_pat_…</code>) —
                  more locked down. To create a new repo from inside pinloom
                  you'll need <em>Administration: write</em> on{' '}
                  <em>All repositories</em>. If you create the repo on GitHub
                  first, the token only needs <em>Contents: write</em> on that
                  specific repo.
                </li>
              </ul>
              <p className="text-[var(--color-ink-muted)] text-xs">
                The token is stored as-is in pinloom's local DB — anyone with
                the DB file effectively has the token, so revoke it on GitHub
                if the file leaks.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder="ghp_… or github_pat_…"
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
                <div className="space-y-2">
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase text-[var(--color-ink-muted)]">
                        Backup repository
                      </div>
                      <div className="font-mono text-sm">
                        {config.repo.fullName}
                      </div>
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={syncNow}
                      disabled={syncing || busy || restoring}
                      className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {syncing ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button
                      type="button"
                      onClick={restoreNow}
                      disabled={syncing || busy || restoring}
                      className="rounded border border-[var(--color-border)] text-sm px-3 py-1.5 hover:border-[var(--color-accent)] disabled:opacity-40"
                    >
                      {restoring ? 'Restoring…' : 'Restore from repo'}
                    </button>
                    {syncResult && !syncing && (
                      <span className="text-xs text-[var(--color-ink-muted)]">
                        {syncResult.committed
                          ? `Pushed wiki snapshot (${formatBytes(syncResult.wikiBytes)}).`
                          : 'No wiki changes to push.'}
                      </span>
                    )}
                    {restoreResult && !restoring && (
                      <span className="text-xs text-[var(--color-ink-muted)]">
                        Imported {restoreResult.wikiFilesImported} wiki file(s).
                      </span>
                    )}
                  </div>
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
                        placeholder="pinloom-wiki"
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
