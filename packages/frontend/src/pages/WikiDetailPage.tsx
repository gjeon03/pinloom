import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, ExternalLink, Pencil, Save, X } from 'lucide-react';
import { api, type WikiPage } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';
import { Tooltip } from '../components/Tooltip.js';

interface EditDraft {
  body: string;
  appliesTo: string;
  topic: string;
  related: string;
  summary: string;
}

function arrayToInput(values: string[]): string {
  return values.join(', ');
}

// Strip HTML comments before handing markdown to react-markdown. The
// renderer is configured without raw-HTML support (intentional, since
// the body comes from user / agent edits), so comments like
// `<!-- pinloom:auto-section -->` end up showing as visible text in the
// preview. The comments themselves stay in the on-disk file — this is
// purely a display filter.
function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

function inputToArray(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function draftFromPage(page: WikiPage): EditDraft {
  return {
    body: page.body,
    appliesTo: arrayToInput(page.meta.appliesTo),
    topic: arrayToInput(page.meta.topic),
    related: arrayToInput(page.meta.related),
    summary: page.meta.summary,
  };
}

export function WikiDetailPage() {
  const params = useParams<{ '*': string }>();
  const filename = params['*'] ?? '';
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

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
    setDraft(null);
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

  function startEdit() {
    if (!page) return;
    setError(null);
    setDraft(draftFromPage(page));
  }

  function cancelEdit() {
    setDraft(null);
    setError(null);
  }

  async function saveEdit() {
    if (!page || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateWikiPage(filename, {
        meta: {
          appliesTo: inputToArray(draft.appliesTo),
          topic: inputToArray(draft.topic),
          related: inputToArray(draft.related),
          summary: draft.summary.trim(),
        },
        body: draft.body,
      });
      setPage(updated);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Cmd/Ctrl-S to save while editing, Esc to cancel. Without this the
  // user has to chase the buttons on each save which gets old fast on a
  // page they're iterating on.
  useEffect(() => {
    if (!draft) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void saveEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, page, filename]);

  const editing = draft !== null;

  return (
    <div className="flex h-full flex-col">
      {/* pr-60 reserves room for the global top-right control cluster (search /
          templates / bots / notepad / notifications) which floats over every
          page at `absolute right-3` (~210px wide) — otherwise it covers this
          header's own Edit/Open buttons. */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] pl-6 pr-60 py-3 flex items-center justify-between gap-4">
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
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Tooltip label="Toggle live preview" side="bottom">
                <button
                  onClick={() => setShowPreview((v) => !v)}
                  className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs ${
                    showPreview
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-3)] hover:border-[var(--color-accent)]'
                  }`}
                >
                  <Eye size={12} />
                  Preview
                </button>
              </Tooltip>
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
              >
                <X size={12} />
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] text-black px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                <Save size={12} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <Tooltip label="Edit this page in place" side="bottom">
                <button
                  onClick={startEdit}
                  disabled={!page}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
                >
                  <Pencil size={12} />
                  Edit
                </button>
              </Tooltip>
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
            </>
          )}
        </div>
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
      ) : editing && draft ? (
        <EditView
          draft={draft}
          onChange={setDraft}
          showPreview={showPreview}
        />
      ) : (
        <ReadView page={page} />
      )}
    </div>
  );
}

function ReadView({ page }: { page: WikiPage }) {
  return (
    <div className="flex-1 overflow-hidden flex">
      <div className="flex-1 min-w-0 overflow-auto px-8 py-6">
        <Markdown content={stripHtmlComments(page.body)} />
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
  );
}

function EditView({
  draft,
  onChange,
  showPreview,
}: {
  draft: EditDraft;
  onChange: (next: EditDraft) => void;
  showPreview: boolean;
}) {
  // Memoize the preview source so an unrelated frontmatter keystroke
  // doesn't re-run the markdown parser on every render. Comments are
  // stripped for the same reason ReadView does it — the renderer shows
  // them as visible text otherwise.
  const previewBody = useMemo(() => stripHtmlComments(draft.body), [draft.body]);

  // Ratio-based scroll sync: when the user scrolls one pane we map its
  // scroll fraction onto the other. The flag ref suppresses the second
  // pane's onScroll (triggered by the programmatic scrollTop assignment)
  // from echoing back and fighting the user.
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef<'editor' | 'preview' | null>(null);
  const syncResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function syncFrom(side: 'editor' | 'preview') {
    if (syncingRef.current && syncingRef.current !== side) return;
    const src = side === 'editor' ? editorRef.current : previewRef.current;
    const dst = side === 'editor' ? previewRef.current : editorRef.current;
    if (!src || !dst) return;
    const maxSrc = src.scrollHeight - src.clientHeight;
    const maxDst = dst.scrollHeight - dst.clientHeight;
    if (maxSrc <= 0 || maxDst <= 0) return;
    const ratio = src.scrollTop / maxSrc;

    syncingRef.current = side;
    dst.scrollTop = ratio * maxDst;
    if (syncResetTimer.current) clearTimeout(syncResetTimer.current);
    syncResetTimer.current = setTimeout(() => {
      syncingRef.current = null;
    }, 60);
  }

  return (
    <div className="flex-1 overflow-hidden flex">
      <div className="flex-1 min-w-0 flex overflow-hidden">
        <div className={`${showPreview ? 'flex-1 border-r border-[var(--color-border)]' : 'flex-1'} min-w-0 flex flex-col`}>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold px-6 pt-4 pb-1">
            Body (markdown)
          </div>
          <textarea
            ref={editorRef}
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            onScroll={() => syncFrom('editor')}
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none bg-[var(--color-surface)] px-6 py-3 text-sm font-mono leading-6 outline-none"
          />
        </div>
        {showPreview && (
          <div
            ref={previewRef}
            onScroll={() => syncFrom('preview')}
            className="flex-1 min-w-0 overflow-auto px-8 py-6 bg-[var(--color-surface-2)]/40"
          >
            <Markdown content={previewBody} />
          </div>
        )}
      </div>
      <aside className="w-64 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface-2)] overflow-auto px-4 py-4 space-y-3 text-sm">
        <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold">
          Frontmatter
        </h3>
        <MetaInput
          label="applies_to"
          value={draft.appliesTo}
          hint="comma-separated project slugs"
          onChange={(v) => onChange({ ...draft, appliesTo: v })}
        />
        <MetaInput
          label="topic"
          value={draft.topic}
          hint="comma-separated topic tags"
          onChange={(v) => onChange({ ...draft, topic: v })}
        />
        <MetaInput
          label="related"
          value={draft.related}
          hint="comma-separated page filenames"
          onChange={(v) => onChange({ ...draft, related: v })}
        />
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
            summary
          </div>
          <textarea
            value={draft.summary}
            onChange={(e) => onChange({ ...draft, summary: e.target.value })}
            rows={3}
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
          />
        </div>
        <div className="text-[10px] text-[var(--color-ink-muted)] pt-2">
          ⌘S to save · Esc to cancel
        </div>
      </aside>
    </div>
  );
}

function MetaInput({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  hint: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] font-semibold mb-1">
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs font-mono"
      />
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
