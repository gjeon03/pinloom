import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Search, X } from 'lucide-react';
import type { MessageSearchResult } from '@pinloom/shared';
import { api, type TimelineSearchHit, type WikiSearchHit } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { gotoSessionTab } from '../utils/gotoSession.js';
import { useT, type TFn } from '../i18n/t.js';
import { useFeatures } from '../stores/uiConfig.js';

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

function timeAgo(iso: string, t: TFn): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return t('cmp.search.ago.s', { n: secs });
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('cmp.search.ago.m', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('cmp.search.ago.h', { n: hrs });
  const days = Math.round(hrs / 24);
  if (days < 30) return t('cmp.search.ago.d', { n: days });
  return new Date(iso).toLocaleDateString();
}

export function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const t = useT();
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

  // Group scope filter (All / a project group / Ungrouped). '' = all.
  const [groupId, setGroupId] = useState('');
  const { data: groups = [] } = useSWR('project-groups', () => api.listProjectGroups());

  const debounced = useDebounce(query.trim(), DEBOUNCE_MS);
  const active = debounced.length >= MIN_CHARS;
  const { data, isLoading } = useSWR(
    active ? ['search', debounced, groupId] : null,
    () => api.search(debounced, { limit: 30, groupId: groupId || undefined }),
    { keepPreviousData: true },
  );
  const results = data?.results ?? [];
  // Drop result groups for disabled features so search never surfaces (or links
  // into) a hidden surface — the route guard would bounce the click anyway.
  const features = useFeatures();
  const timeline = features.timeline ? (data?.timeline ?? []) : [];
  const wiki = features.wiki ? (data?.wiki ?? []) : [];

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
    gotoSessionTab(navigate, result.projectId, result.sessionId, result.messageId);
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

  function openWiki(w: WikiSearchHit) {
    navigate(`/wiki/${encodeURIComponent(`${w.slug}.md`)}`);
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
    if (!active) return t('cmp.search.hint', { n: MIN_CHARS });
    const total = results.length + timeline.length + wiki.length;
    if (isLoading && total === 0) return t('cmp.search.searching');
    if (total === 0) return t('cmp.search.noMatches');
    return `${t('cmp.search.messageCount', { n: results.length })}${
      timeline.length > 0 ? ` · ${t('cmp.search.timelineCount', { n: timeline.length })}` : ''
    }${wiki.length > 0 ? ` · ${t('cmp.search.wikiCount', { n: wiki.length })}` : ''}`;
  }, [t, active, isLoading, results.length, timeline.length, wiki.length]);

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
        aria-label={t('cmp.search.ariaLabel')}
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
            placeholder={t('cmp.search.placeholder')}
            className="flex-1 bg-transparent text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-muted)]"
          />
          {groups.length > 0 && (
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              title={t('cmp.search.scopeTitle')}
              className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-1 text-xs text-[var(--color-ink-muted)]"
            >
              <option value="">{t('cmp.search.all')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="__ungrouped__">{t('cmp.search.ungrouped')}</option>
            </select>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
            title={t('cmp.search.close')}
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
                  {r.sessionTitle || t('cmp.search.untitledSession')}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {timeAgo(r.createdAt, t)}
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
                {t('cmp.search.workTimeline')}
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

          {wiki.length > 0 && (
            <div className="mt-1 border-t border-[var(--color-border)] pt-1">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                {t('cmp.search.wiki')}
              </div>
              {wiki.map((w) => (
                <button
                  key={w.slug}
                  onClick={() => openWiki(w)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--color-surface-3)]"
                >
                  <div className="text-[11px] font-medium text-[var(--color-ink)]">📖 {w.title}</div>
                  <div className="line-clamp-2 text-xs text-[var(--color-ink-muted)]">{w.excerpt}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
          {status}
          <span className="float-right hidden sm:inline">
            {t('cmp.search.kbdHints')}
          </span>
        </div>
      </div>
    </div>
  );
}
