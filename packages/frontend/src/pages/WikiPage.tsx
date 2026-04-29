import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api, type WikiOverview, type WikiPage } from '../api/client.js';
import { WikiSyncPicker } from '../components/WikiSyncPicker.js';
import { Tooltip } from '../components/Tooltip.js';

type ScopeFilter = string | null; // null = all
type TopicFilter = string | null;

function pageScope(page: WikiPage): string {
  if (page.meta.appliesTo.length === 0) return 'global';
  if (page.meta.appliesTo.length === 1) return page.meta.appliesTo[0];
  return page.meta.appliesTo.join(' + ');
}

function pageMatchesScope(page: WikiPage, scope: ScopeFilter): boolean {
  if (!scope) return true;
  if (scope === 'global') {
    return page.meta.appliesTo.length === 0 || page.meta.appliesTo.includes('global');
  }
  return page.meta.appliesTo.includes(scope);
}

function pageMatchesTopic(page: WikiPage, topic: TopicFilter): boolean {
  if (!topic) return true;
  return page.meta.topic.includes(topic);
}

function groupByTopic(pages: WikiPage[]): { topic: string; pages: WikiPage[] }[] {
  const buckets = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const primary = page.meta.topic[0] ?? 'misc';
    const bucket = buckets.get(primary) ?? [];
    bucket.push(page);
    buckets.set(primary, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === 'misc') return 1;
      if (b === 'misc') return -1;
      return a.localeCompare(b);
    })
    .map(([topic, pages]) => ({ topic, pages }));
}

export function WikiPage() {
  const [overview, setOverview] = useState<WikiOverview | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<ScopeFilter>(null);
  const [topic, setTopic] = useState<TopicFilter>(null);
  const [showSyncPicker, setShowSyncPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  async function refresh() {
    try {
      const [ov, ps] = await Promise.all([api.wikiOverview(), api.listProjects()]);
      setOverview(ov);
      setProjects(ps);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const pages = overview?.pages ?? [];

  const allTopics = useMemo(() => {
    const set = new Set<string>();
    for (const p of pages) {
      for (const t of p.meta.topic) set.add(t);
    }
    return [...set].sort();
  }, [pages]);

  const filtered = useMemo(
    () => pages.filter((p) => pageMatchesScope(p, scope) && pageMatchesTopic(p, topic)),
    [pages, scope, topic],
  );
  const groups = useMemo(() => groupByTopic(filtered), [filtered]);

  async function handleOpenFolder() {
    try {
      await api.wikiOpenFolder();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="pl-6 pr-16 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">Wiki</h1>
              <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)] font-mono">
                {overview?.wikiRoot ?? '~/.pinloom/wiki'}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Tooltip label="Sync from a session" side="bottom">
                <button
                  onClick={() => setShowSyncPicker(true)}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <RefreshCw size={12} />
                  Sync
                </button>
              </Tooltip>
              <Tooltip label="Analyze project (coming soon)" side="bottom">
                <button
                  disabled
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs opacity-60"
                >
                  <Sparkles size={12} />
                  Analyze
                </button>
              </Tooltip>
              <Tooltip label="Open wiki folder" side="bottom">
                <button
                  onClick={handleOpenFolder}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <FolderOpen size={12} />
                  Folder
                </button>
              </Tooltip>
              <Tooltip label="Reload" side="bottom">
                <button
                  onClick={refresh}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <RefreshCw size={12} />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Filter chips */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <FilterPill
              label="All"
              active={scope === null}
              onClick={() => setScope(null)}
            />
            <FilterPill
              label="global"
              active={scope === 'global'}
              onClick={() => setScope(scope === 'global' ? null : 'global')}
              tone="muted"
            />
            {projects.map((p) => {
              const slug = wikiSlugForProject(p, projects);
              return (
                <FilterPill
                  key={p.id}
                  label={p.name}
                  sub={slug}
                  active={scope === slug}
                  onClick={() => setScope(scope === slug ? null : slug)}
                />
              );
            })}
          </div>

          {allTopics.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mr-1">
                Topics
              </span>
              <FilterPill
                label="any"
                active={topic === null}
                onClick={() => setTopic(null)}
                tone="muted"
                small
              />
              {allTopics.map((t) => (
                <FilterPill
                  key={t}
                  label={t}
                  active={topic === t}
                  onClick={() => setTopic(topic === t ? null : t)}
                  small
                />
              ))}
            </div>
          )}
        </div>

        {lastSyncSummary && (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-2 text-[11px] text-[var(--color-ink-muted)]">
            <span className="font-medium text-[var(--color-ink)]">Last sync:</span>{' '}
            {lastSyncSummary.length > 240
              ? `${lastSyncSummary.slice(0, 240)}…`
              : lastSyncSummary}
          </div>
        )}
        {error && (
          <div className="border-t border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-6 py-2 text-[11px] text-[var(--color-error-ink)]">
            {error}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-sm text-[var(--color-ink-muted)]">Loading wiki…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-sm text-[var(--color-ink-muted)]">
            {pages.length === 0
              ? 'No pages yet. Run a wiki sync from any session to populate.'
              : 'No pages match the current filters.'}
          </div>
        ) : (
          <div className="px-6 py-4 space-y-6">
            {groups.map((group) => (
              <section key={group.topic}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
                  {group.topic}
                </h2>
                <ul className="space-y-1">
                  {group.pages.map((page) => (
                    <li key={page.relPath}>
                      <Link
                        to={`/wiki/${encodeURIComponent(page.relPath)}`}
                        className="group flex items-baseline gap-2 rounded px-2 py-1.5 hover:bg-[var(--color-surface-3)]"
                      >
                        <span className="text-sm font-medium text-[var(--color-ink)] group-hover:text-[var(--color-accent)]">
                          {page.title}
                        </span>
                        <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-ink-muted)]">
                          {pageScope(page)}
                        </span>
                        {page.meta.topic.slice(0, 3).map((t) => (
                          <span
                            key={t}
                            className="text-[10px] font-mono text-[var(--color-ink-muted)]"
                          >
                            #{t}
                          </span>
                        ))}
                        {page.meta.summary && (
                          <span className="text-[12px] text-[var(--color-ink-muted)] truncate flex-1">
                            — {page.meta.summary}
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-[var(--color-ink-muted)] opacity-0 group-hover:opacity-60">
                          {page.relPath}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {showSyncPicker && (
        <WikiSyncPicker
          onClose={() => setShowSyncPicker(false)}
          onSynced={(_c, output) => {
            setLastSyncSummary(output);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

interface FilterPillProps {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
  tone?: 'default' | 'muted';
  small?: boolean;
}

function FilterPill({ label, sub, active, onClick, tone = 'default', small }: FilterPillProps) {
  const base = small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]';
  const palette = active
    ? 'bg-[var(--color-accent)]/20 text-[var(--color-ink)] border-[var(--color-accent)]'
    : tone === 'muted'
      ? 'border-[var(--color-border)] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)]'
      : 'border-[var(--color-border)] text-[var(--color-ink)] hover:border-[var(--color-accent)]';
  return (
    <button
      onClick={onClick}
      className={`rounded border ${palette} ${base} font-medium`}
    >
      {label}
      {sub && <span className="ml-1 font-mono opacity-60">{sub}</span>}
    </button>
  );
}

function slugifyBasename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// Mirror of backend computeWikiSlug — basename of cwd, with collision suffix.
function wikiSlugForProject(project: Project, all: Project[]): string {
  const base = slugifyBasename(basename(project.cwd));
  const collision = all.some(
    (p) => p.id !== project.id && slugifyBasename(basename(p.cwd)) === base,
  );
  return collision ? `${base}-${project.id.slice(0, 6)}` : base;
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
