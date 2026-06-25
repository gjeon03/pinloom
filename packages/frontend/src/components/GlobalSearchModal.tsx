import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Search, X } from 'lucide-react';
import type { MessageSearchResult } from '@pinloom/shared';
import { api, type TimelineSearchHit } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { gotoSessionTab } from '../utils/gotoSession.js';

// Global full-text search over conversation history (knowledge-system v2,
// Phase 1). A command-palette modal: type → debounced /api/search → pick a
// result → jump to that session. Results highlight the matched span; we open
// the SESSION (not a specific message — message-level scroll is deferred).
const MIN_CHARS = 2;
const DEBOUNCE_MS = 220;

function renderExcerpt(
  excerpt: string,
  highlights: [number, number][],
): ReactNode {
  if (!highlights.length) return excerpt;
  const out: ReactNode[] = [];
  let pos = 0;
  highlights.forEach(([s, e], i) => {
    if (s > pos) out.push(excerpt.slice(pos, s));
    out.push(
      <mark
        key={i}
        className="rounded-sm bg-[var(--color-accent)]/30 text-[var(--color-ink)]"
      >
        {excerpt.slice(s, e)}
      </mark>,
    );
    pos = Math.max(pos, e);
  });
  if (pos < excerpt.length) out.push(excerpt.slice(pos));
  return out;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // True right after an arrow key moved the cursor, so the resulting
  // scrollIntoView (which can slide a row under a resting pointer) doesn't let
  // mouseenter yank the selection back. Cleared on a real mouse move.
  const keyboardNavRef = useRef(false);
  // Only close on a backdrop click that also STARTED on the backdrop, so a
  // text-selection drag that releases outside the input doesn't dismiss.
  const downOnBackdropRef = useRef(false);

  const debounced = useDebounce(query.trim(), DEBOUNCE_MS);
  const active = debounced.length >= MIN_CHARS;
  const { data, isLoading } = useSWR(
    active ? cacheKeys.search(debounced, null) : null,
    () => api.search(debounced, { limit: 30 }),
    { keepPreviousData: true },
  );
  const results = data?.results ?? [];
  const timeline = data?.timeline ?? [];

  // Reset the cursor on a NEW query (not on every `results` identity change —
  // a background revalidation must not snap the selection back to 0).
  useEffect(() => {
    setSelected(0);
  }, [debounced]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the selected row in view as the cursor moves.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function open(result: MessageSearchResult) {
    gotoSessionTab(navigate, result.projectId, result.sessionId);
    onClose();
  }

  function openTimeline(t: TimelineSearchHit) {
    // Deep-link: preselect the project + date the Timeline page restores from.
    try {
      localStorage.setItem('pinloom:timeline:project', t.projectId);
      localStorage.setItem('pinloom:timeline:date', t.date);
    } catch {
      // ignore
    }
    navigate('/timeline');
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      keyboardNavRef.current = true;
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      keyboardNavRef.current = true;
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[selected];
      if (hit) open(hit);
    }
  }

  const status = useMemo(() => {
    if (!active)
      return `Type at least ${MIN_CHARS} characters to search your history`;
    if (isLoading && results.length === 0 && timeline.length === 0) return 'Searching…';
    const total = results.length + timeline.length;
    if (total === 0) return 'No matches';
    return `${results.length} message${results.length === 1 ? '' : 's'}${
      timeline.length > 0 ? ` · ${timeline.length} timeline` : ''
    }`;
  }, [active, isLoading, results.length, timeline.length]);

  return (
    <div
      onMouseDown={(e) => {
        downOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search conversation history"
        onKeyDown={onKeyDown}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]"
        style={{ maxHeight: 'min(640px, 80vh)' }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          <Search size={16} className="shrink-0 text-[var(--color-ink-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversation history…"
            className="flex-1 bg-transparent text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-muted)]"
          />
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        <div
          ref={listRef}
          onMouseMove={() => {
            keyboardNavRef.current = false;
          }}
          className={`flex-1 overflow-auto py-1 transition-opacity ${
            isLoading && results.length > 0 ? 'opacity-60' : ''
          }`}
        >
          {results.map((r, i) => (
            <button
              key={r.messageId}
              data-idx={i}
              onClick={() => open(r)}
              onMouseEnter={() => {
                if (!keyboardNavRef.current) setSelected(i);
              }}
              className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left ${
                i === selected ? 'bg-[var(--color-surface-3)]' : ''
              }`}
            >
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-muted)]">
                <span className="truncate font-medium text-[var(--color-ink)]">
                  {r.projectName}
                </span>
                <span aria-hidden>·</span>
                <span className="truncate">
                  {r.sessionTitle || 'Untitled session'}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {timeAgo(r.createdAt)}
                </span>
              </div>
              <div className="line-clamp-2 text-xs text-[var(--color-ink)]">
                <span className="mr-1 text-[10px] uppercase text-[var(--color-ink-muted)]">
                  {r.role}
                </span>
                {renderExcerpt(r.excerpt, r.highlights)}
              </div>
            </button>
          ))}

          {timeline.length > 0 && (
            <div className="mt-1 border-t border-[var(--color-border)] pt-1">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                Work timeline
              </div>
              {timeline.map((t) => (
                <button
                  key={`${t.projectId}:${t.date}`}
                  onClick={() => openTimeline(t)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--color-surface-3)]"
                >
                  <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-muted)]">
                    <span className="truncate font-medium text-[var(--color-ink)]">
                      🗓 {t.projectName}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">{t.date}</span>
                  </div>
                  <div className="line-clamp-2 text-xs text-[var(--color-ink)]">{t.excerpt}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
          {status}
          <span className="float-right hidden sm:inline">
            ↑↓ navigate · ↵ open · esc close
          </span>
        </div>
      </div>
    </div>
  );
}
