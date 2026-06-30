import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Check, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { Markdown } from './Markdown.js';
import { useT } from '../i18n/t.js';

// Side-panel "Session Timeline" tab: a persisted handover digest for the
// session (structured summary + day-by-day detail). Loads the saved doc; the
// user generates/regenerates on demand. Read-only artifact — copy or export.
export function SessionTimelineTab({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [md, setMd] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Source of truth = the server's GET (markdown + `generating`). Re-reading it
  // on mount means navigating away and back shows the real state ("generating"
  // vs done), and we poll while a generation is in flight so completion lands
  // even though the click happened on a since-unmounted instance.
  function load() {
    api
      .getHandover(sessionId)
      .then((r) => {
        if (!aliveRef.current) return;
        setMd(r.markdown);
        setGeneratedAt(r.generatedAt);
        setGenerating(r.generating);
        setLoaded(true);
        if (r.generating) pollRef.current = setTimeout(load, 3000);
      })
      .catch(() => aliveRef.current && setLoaded(true));
  }

  useEffect(() => {
    aliveRef.current = true;
    setLoaded(false);
    load();
    return () => {
      aliveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      await api.generateHandover(sessionId); // resolves when done (or joins an in-flight run)
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) load(); // refresh from server (markdown + generating=false)
    }
  }
  function copy() {
    if (!md) return;
    void navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  function download() {
    if (!md) return;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-timeline-${sessionId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const btn =
    'inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-40';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <button type="button" onClick={generate} disabled={generating} className={btn}>
          <RefreshCw size={13} className={generating ? 'animate-spin' : ''} />
          {generating
            ? t('cmp.handover.generating')
            : md
              ? t('cmp.handover.regenerate')
              : t('cmp.handover.generate')}
        </button>
        {md && (
          <>
            <button type="button" onClick={copy} className={btn}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? t('cmp.handover.copied') : t('cmp.handover.copy')}
            </button>
            <button type="button" onClick={download} className={btn}>
              <Download size={13} />
              {t('cmp.handover.download')}
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {error ? (
          <p className="text-sm text-red-400">{t('cmp.handover.error', { error })}</p>
        ) : generating ? (
          <p className="text-sm text-[var(--color-ink-muted)]">{t('cmp.handover.generatingHint')}</p>
        ) : !loaded ? (
          <p className="text-sm text-[var(--color-ink-muted)]">{t('cmp.handover.loading')}</p>
        ) : !md ? (
          <p className="text-sm text-[var(--color-ink-muted)]">{t('cmp.handover.empty')}</p>
        ) : (
          <div className="text-sm">
            <Markdown content={md} />
          </div>
        )}
      </div>
    </div>
  );
}
