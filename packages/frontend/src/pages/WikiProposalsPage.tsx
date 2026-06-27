import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { diffLines } from 'diff';
import { ArrowLeft, Archive, FileEdit, Check, X, AlertTriangle } from 'lucide-react';
import type { WikiProposal } from '@pinloom/shared';
import { api } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';

// Wiki gardener review inbox (knowledge-system v2 Phase 2). Lists pending
// proposals, shows a before/after diff, and lets the user accept (applies via
// the curation primitives) or reject. Proposals are authored by the gardener
// (Phase 2b); until then this surfaces whatever has been staged.

function KindIcon({ kind }: { kind: WikiProposal['kind'] }) {
  return kind === 'archive_page' ? <Archive size={13} /> : <FileEdit size={13} />;
}

// Unified git-style line diff between the page now (before) and what the
// proposal would produce (after). Added lines are green (+), removed red (−),
// context grey — so it's obvious WHAT changed, not just two full blobs.
function DiffView({ before, after }: { before: string | null; after: string | null }) {
  const parts = useMemo(() => diffLines(before ?? '', after ?? ''), [before, after]);
  const adds = parts.filter((p) => p.added).reduce((n, p) => n + (p.count ?? 0), 0);
  const dels = parts.filter((p) => p.removed).reduce((n, p) => n + (p.count ?? 0), 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-1 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
        Diff
        {adds > 0 && <span className="text-emerald-400">+{adds}</span>}
        {dels > 0 && <span className="text-[#f7768e]">−{dels}</span>}
        {after === null && <span className="text-[#f7768e]">page removed → archive</span>}
      </div>
      <div className="flex-1 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] font-mono text-[11px] leading-relaxed">
        {parts.map((part, i) => {
          const sign = part.added ? '+' : part.removed ? '-' : ' ';
          const cls = part.added
            ? 'bg-emerald-500/12 text-emerald-300'
            : part.removed
              ? 'bg-[#f7768e]/12 text-[#f7768e]'
              : 'text-[var(--color-ink-muted)]';
          // diffLines keeps the trailing newline on each part; drop it so the
          // final empty line doesn't render as a stray row.
          return part.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line, j) => (
              <div key={`${i}-${j}`} className={`flex ${cls}`}>
                <span className="w-4 shrink-0 select-none text-center opacity-50">{sign}</span>
                <span className="whitespace-pre-wrap break-words pr-2">{line || ' '}</span>
              </div>
            ));
        })}
      </div>
    </div>
  );
}

function ProposalDetail({
  id,
  onResolved,
}: {
  id: string;
  onResolved: () => void;
}) {
  const { data: diff, isLoading } = useSWR(cacheKeys.wikiProposalDiff(id), () =>
    api.getWikiProposalDiff(id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !diff) {
    return <div className="p-4 text-sm text-[var(--color-ink-muted)]">Loading…</div>;
  }
  const { proposal, before, after, stale } = diff;
  const blocked = stale || diff.error !== null || proposal.status !== 'pending';

  async function act(kind: 'accept' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'accept') await api.acceptWikiProposal(id);
      else await api.rejectWikiProposal(id);
      // Only refresh the list (shared by the inbox + the WikiPage badge). We
      // deliberately do NOT revalidate this proposal's diff — we're navigating
      // away from it, and repopulating its now-applied/rejected diff would
      // briefly flash a resolved proposal in the pane.
      await mutate(cacheKeys.wikiProposals('pending'));
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <KindIcon kind={proposal.kind} />
        <span className="text-sm font-medium">{proposal.title}</span>
        <span className="ml-auto font-mono text-[11px] text-[var(--color-ink-muted)]">
          {proposal.relPath}
        </span>
      </div>

      {stale && (
        <div className="flex items-center gap-1.5 rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-300">
          <AlertTriangle size={12} /> The page changed since this proposal — it
          can't be applied. Regenerate it.
        </div>
      )}
      {diff.error && (
        <div className="flex items-center gap-1.5 rounded border border-[#f7768e]/40 bg-[#f7768e]/10 px-2 py-1 text-[11px] text-[#f7768e]">
          <AlertTriangle size={12} /> {diff.error}
        </div>
      )}

      <DiffView before={before} after={after} />

      {error && <div className="text-[11px] text-[#f7768e]">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => act('accept')}
          disabled={busy || blocked}
          className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
        >
          <Check size={13} /> Accept
        </button>
        <button
          onClick={() => act('reject')}
          disabled={busy || proposal.status !== 'pending'}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[#f7768e] hover:text-[#f7768e] disabled:opacity-40"
        >
          <X size={13} /> Reject
        </button>
      </div>
    </div>
  );
}

export function WikiProposalsPage() {
  const {
    data: proposals = [],
    error,
    isLoading,
  } = useSWR(cacheKeys.wikiProposals('pending'), () =>
    api.listWikiProposals('pending'),
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Resolve against list membership, not raw `selected` — so a proposal that
  // leaves the list (accepted/rejected here, or resolved in another tab via
  // SWR revalidation) never lingers as a dangling selection or a stale pane.
  const activeId =
    (selected && proposals.some((p) => p.id === selected)
      ? selected
      : proposals[0]?.id) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] pl-6 pr-[136px] py-4">
        <Link
          to="/wiki"
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft size={12} /> Wiki
        </Link>
        <h1 className="mt-0.5 text-lg font-semibold">Gardener proposals</h1>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          Review and apply the gardener's suggested wiki cleanups. Accepting
          applies the change; rejecting discards it. Nothing is auto-applied.
        </p>
      </div>

      {error ? (
        <div className="p-6 text-sm text-[#f7768e]">
          Failed to load proposals:{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : isLoading ? (
        <div className="p-6 text-sm text-[var(--color-ink-muted)]">Loading…</div>
      ) : proposals.length === 0 ? (
        <div className="p-6 text-sm text-[var(--color-ink-muted)]">
          No pending proposals.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-72 shrink-0 overflow-auto border-r border-[var(--color-border)]">
            {proposals.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelected(p.id)}
                  aria-current={p.id === activeId ? 'true' : undefined}
                  className={`flex w-full items-center gap-2 border-b border-[var(--color-border)]/40 px-3 py-2 text-left text-xs ${
                    p.id === activeId
                      ? 'bg-[var(--color-surface-3)]'
                      : 'hover:bg-[var(--color-surface-3)]'
                  }`}
                >
                  <KindIcon kind={p.kind} />
                  <span className="flex-1 truncate">
                    <span className="font-medium">{p.title}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {p.relPath}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1">
            {activeId && (
              <ProposalDetail
                key={activeId}
                id={activeId}
                onResolved={() => setSelected(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
