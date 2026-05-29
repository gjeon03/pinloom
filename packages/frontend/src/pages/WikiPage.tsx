import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FolderOpen, RefreshCw, Sparkles, Upload } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import {
  api,
  type WikiImportSummary,
  type WikiOverview,
  type WikiPage,
} from '../api/client.js';
import { WikiSyncPicker } from '../components/WikiSyncPicker.js';
import { WikiAnalyzePicker } from '../components/WikiAnalyzePicker.js';
import { Tooltip } from '../components/Tooltip.js';
import {
  analyzeNotificationId,
  useNotifications,
} from '../stores/notifications.js';

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
  const [showAnalyzePicker, setShowAnalyzePicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [lastAnalyzeSummary, setLastAnalyzeSummary] = useState<string | null>(null);
  const notifications = useNotifications();

  const runningAnalyzeProjectIds = useMemo(() => {
    const set = new Set<string>();
    for (const it of notifications.items) {
      if (
        it.kind === 'wiki-analyze' &&
        it.status === 'running' &&
        it.meta?.projectId
      ) {
        set.add(it.meta.projectId);
      }
    }
    return set;
  }, [notifications.items]);

  function analyzeProject(project: Project) {
    if (runningAnalyzeProjectIds.has(project.id)) return;
    // Frontend chooses startedAt and sends it to the backend so both sides
    // agree on the deterministic notification id, even across page reloads.
    const startedAt = new Date().toISOString();
    const notifId = analyzeNotificationId({ projectId: project.id, startedAt });
    notifications.start({
      id: notifId,
      kind: 'wiki-analyze',
      title: `Analyzing ${project.name}`,
      meta: { projectId: project.id, projectName: project.name },
    });
    void (async () => {
      try {
        const result = await api.wikiAnalyze({
          projectId: project.id,
          dimension: 'conventions',
          startedAt,
        });
        notifications.resolve(notifId, result.output);
        setLastAnalyzeSummary(`${project.name} — ${result.output}`);
        void refresh();
      } catch (e) {
        notifications.fail(notifId, e instanceof Error ? e.message : String(e));
      }
    })();
  }

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

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  async function handleOpenFolder() {
    try {
      await api.wikiOpenFolder();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExport() {
    setError(null);
    try {
      const blob = await api.wikiExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `pinloom-wiki-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runImport(mode: 'skip' | 'overwrite') {
    if (!pendingImportFile) return;
    setError(null);
    setImporting(true);
    try {
      const buf = await pendingImportFile.arrayBuffer();
      const dataBase64 = bufferToBase64(buf);
      const summary = await api.wikiImport({ mode, dataBase64 });
      setPendingImportFile(null);
      // Pull fresh overview so the new pages render.
      void refresh();
      window.alert(formatImportSummary(summary));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
        {/* pr clears the fixed top-right control cluster (github/notepad/bell). */}
        <div className="pl-6 pr-[136px] py-4">
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
              <Tooltip
                label="Analyze a project's codebase for conventions"
                side="bottom"
              >
                <button
                  onClick={() => setShowAnalyzePicker(true)}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
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
              <Tooltip label="Export wiki as zip" side="bottom">
                <button
                  onClick={handleExport}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <Download size={12} />
                  Export
                </button>
              </Tooltip>
              <Tooltip label="Import wiki from zip (auto-backs up first)" side="bottom">
                <button
                  onClick={() => importInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <Upload size={12} />
                  Import
                </button>
              </Tooltip>
              <input
                ref={importInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setPendingImportFile(f);
                  // Reset so picking the same file twice still triggers onChange.
                  e.target.value = '';
                }}
              />
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
        {lastAnalyzeSummary && (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-2 text-[11px] text-[var(--color-ink-muted)]">
            <span className="font-medium text-[var(--color-ink)]">Last analysis:</span>{' '}
            {lastAnalyzeSummary.length > 240
              ? `${lastAnalyzeSummary.slice(0, 240)}…`
              : lastAnalyzeSummary}
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
      {showAnalyzePicker && (
        <WikiAnalyzePicker
          projects={projects}
          runningProjectIds={runningAnalyzeProjectIds}
          onAnalyze={analyzeProject}
          onClose={() => setShowAnalyzePicker(false)}
        />
      )}
      {pendingImportFile && (
        <ImportModeModal
          fileName={pendingImportFile.name}
          busy={importing}
          onCancel={() => setPendingImportFile(null)}
          onConfirm={runImport}
        />
      )}
    </div>
  );
}

interface ImportModeModalProps {
  fileName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (mode: 'skip' | 'overwrite') => void;
}

function ImportModeModal({
  fileName,
  busy,
  onCancel,
  onConfirm,
}: ImportModeModalProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold">Import wiki</div>
        <div className="mb-3 text-[11px] text-[var(--color-ink-muted)] font-mono truncate">
          {fileName}
        </div>
        <p className="mb-4 text-xs text-[var(--color-ink-muted)]">
          The current wiki is automatically backed up to{' '}
          <span className="font-mono">~/.pinloom/wiki-backups/</span> before any change.
        </p>
        <div className="flex flex-col gap-2">
          <button
            disabled={busy}
            onClick={() => onConfirm('skip')}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-2 text-left text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            <div className="font-medium">Skip duplicates</div>
            <div className="text-[10px] text-[var(--color-ink-muted)]">
              Existing files are kept; only new files are added.
            </div>
          </button>
          <button
            disabled={busy}
            onClick={() => onConfirm('overwrite')}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-2 text-left text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            <div className="font-medium">Overwrite duplicates</div>
            <div className="text-[10px] text-[var(--color-ink-muted)]">
              Existing files with the same path are replaced. Files not in the zip stay untouched.
            </div>
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            disabled={busy}
            onClick={onCancel}
            className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

function bufferToBase64(buf: ArrayBuffer): string {
  // Avoid String.fromCharCode(...largeArray) stack overflow on big files
  // by chunking. 0x8000 is well under V8's spread-arg limit.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function formatImportSummary(s: WikiImportSummary): string {
  return [
    `Wiki import (${s.mode}):`,
    `  Added:       ${s.added.length}`,
    `  Overwritten: ${s.overwritten.length}`,
    `  Skipped:     ${s.skipped.length}`,
    ``,
    `Backup written to:`,
    s.backupPath,
  ].join('\n');
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
