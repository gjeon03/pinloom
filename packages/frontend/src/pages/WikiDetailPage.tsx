import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { api, type WikiPage } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';
import { Tooltip } from '../components/Tooltip.js';

export function WikiDetailPage() {
  const params = useParams<{ '*': string }>();
  const filename = params['*'] ?? '';
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const p = await api.wikiPage(filename);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  async function handleOpenInEditor() {
    if (!page) return;
    try {
      await api.wikiOpenInEditor(page.relPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] pl-6 pr-16 py-3 flex items-center justify-between gap-4">
        <Link
          to="/wiki"
          className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
        >
          <ArrowLeft size={14} />
          Wiki
        </Link>
        <div className="text-[11px] font-mono text-[var(--color-ink-muted)] truncate flex-1 text-center">
          {filename}
        </div>
        <Tooltip label="Open in default editor (macOS)" side="bottom">
          <button
            onClick={handleOpenInEditor}
            disabled={!page}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            <ExternalLink size={12} />
            Open
          </button>
        </Tooltip>
      </div>

      {error && (
        <div className="border-b border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-6 py-2 text-[11px] text-[var(--color-error-ink)]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-sm text-[var(--color-ink-muted)]">Loading…</div>
      ) : !page ? (
        <div className="p-8 text-sm text-[var(--color-ink-muted)]">
          Page not found.
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 min-w-0 overflow-auto px-8 py-6">
            <Markdown content={page.body} />
          </div>
          <aside className="w-64 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface-2)] overflow-auto px-4 py-4">
            <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-2">
              Frontmatter
            </h3>
            <MetaList label="applies_to" values={page.meta.appliesTo} fallback="(global)" />
            <MetaList label="topic" values={page.meta.topic} fallback="(none)" />
            <MetaRelated values={page.meta.related} />
            {page.meta.summary && (
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
                  summary
                </div>
                <div className="text-xs text-[var(--color-ink)]">{page.meta.summary}</div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function MetaList({
  label,
  values,
  fallback,
}: {
  label: string;
  values: string[];
  fallback: string;
}) {
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
        {label}
      </div>
      {values.length === 0 ? (
        <div className="text-xs text-[var(--color-ink-muted)] italic">{fallback}</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-mono"
            >
              {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MetaRelated({ values }: { values: string[] }) {
  if (values.length === 0) {
    return (
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
          related
        </div>
        <div className="text-xs text-[var(--color-ink-muted)] italic">(none)</div>
      </div>
    );
  }
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
        related
      </div>
      <ul className="space-y-1">
        {values.map((v) => (
          <li key={v}>
            <Link
              to={`/wiki/${encodeURIComponent(v)}`}
              className="text-[11px] text-[var(--color-accent)] hover:underline font-mono"
            >
              {v}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
