import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { api, type WikiSyncCandidate } from '../api/client.js';

interface Props {
  onClose: () => void;
  onSynced: (candidate: WikiSyncCandidate, output: string) => void;
}

function describeAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function WikiSyncPicker({ onClose, onSynced }: Props) {
  const [candidates, setCandidates] = useState<WikiSyncCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .wikiSyncCandidates()
      .then(setCandidates)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function syncOne(c: WikiSyncCandidate) {
    setBusyId(c.id);
    setError(null);
    try {
      const result = await api.syncWiki(c.id);
      setDoneId(c.id);
      onSynced(
        c,
        result.staged > 0
          ? `${result.staged}개 변경이 검토 대기 — Proposals에서 확인`
          : '새로 담을 지식이 없어요',
      );
      setTimeout(() => onClose(), 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ maxHeight: 'min(640px, 85vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Sync session to wiki</h2>
            <p className="text-[11px] text-[var(--color-ink-muted)]">
              Pick a session — its new messages will be ingested into the wiki.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="px-4 py-6 text-xs text-[var(--color-ink-muted)] text-center">
              Loading sessions…
            </div>
          )}
          {!loading && candidates.length === 0 && (
            <div className="px-4 py-6 text-xs text-[var(--color-ink-muted)] text-center">
              No sessions yet.
            </div>
          )}
          {!loading &&
            candidates.map((c) => {
              const busy = busyId === c.id;
              const done = doneId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => !busy && !done && syncOne(c)}
                  disabled={busy || done}
                  className="w-full text-left px-4 py-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-3)] disabled:opacity-60 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)] mb-0.5">
                      <span className="font-medium">{c.projectName ?? c.projectBasename}</span>
                      <span>·</span>
                      <span className="font-mono opacity-70 truncate">{c.projectCwd}</span>
                    </div>
                    <div className="text-sm font-medium truncate">
                      {c.title ?? '(untitled session)'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-[11px] text-[var(--color-ink-muted)]">
                      <span>{describeAge(c.updatedAt)}</span>
                      {c.unsyncedCount > 0 ? (
                        <span className="text-[var(--color-accent)]">
                          {c.unsyncedCount} new message{c.unsyncedCount === 1 ? '' : 's'}
                        </span>
                      ) : c.lastSyncedMessageId ? (
                        <span>up to date</span>
                      ) : (
                        <span>never synced</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 mt-1">
                    {busy ? (
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                    ) : done ? (
                      <Check size={14} className="text-emerald-500" />
                    ) : null}
                  </div>
                </button>
              );
            })}
        </div>

        {error && (
          <div className="border-t border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-4 py-2 text-[11px] text-[var(--color-error-ink)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
