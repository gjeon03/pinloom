import { useEffect, useRef, useState } from 'react';
import type { BrowseResponse } from '../api/client.js';
import { api } from '../api/client.js';

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function DirectoryPicker({ initialPath, onSelect, onClose }: Props) {
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    navigate(initialPath);
  }, []);

  async function navigate(path?: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browseDir(path, showHidden);
      setBrowse(result);
      setManualInput(result.path);
      setFocusIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (browse) navigate(browse.path);
  }, [showHidden]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (!browse) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex((i) => Math.min(browse.entries.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        const entry = browse.entries[focusIndex];
        if (entry) {
          e.preventDefault();
          navigate(`${browse.path === '/' ? '' : browse.path}/${entry.name}`);
        }
      } else if (e.key === 'Backspace' && document.activeElement?.tagName !== 'INPUT') {
        if (browse.parent) {
          e.preventDefault();
          navigate(browse.parent);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [browse, focusIndex, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[focusIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  function breadcrumbs(path: string): string[] {
    if (path === '/') return ['/'];
    const parts = path.split('/').filter(Boolean);
    const accum: string[] = ['/'];
    let current = '';
    for (const p of parts) {
      current += `/${p}`;
      accum.push(current);
    }
    return accum;
  }

  function submit() {
    if (browse) onSelect(browse.path);
  }

  function submitManual() {
    if (manualInput.trim()) {
      navigate(manualInput.trim());
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ height: 'min(640px, 80vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Choose a directory</h2>
          <button onClick={onClose} className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
            ✕
          </button>
        </div>

        <div className="border-b border-[var(--color-border)] px-3 py-2 flex gap-2 items-center">
          <input
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitManual();
              }
            }}
            placeholder="/absolute/path or ~/..."
            className="flex-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1 text-xs font-mono"
          />
          <button
            onClick={submitManual}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Go
          </button>
        </div>

        {browse && (
          <div className="border-b border-[var(--color-border)] px-3 py-2 flex items-center gap-1 text-xs overflow-x-auto whitespace-nowrap">
            {breadcrumbs(browse.path).map((crumb, i, arr) => {
              const label = crumb === '/' ? '/' : crumb.split('/').pop();
              const isLast = i === arr.length - 1;
              return (
                <span key={crumb} className="flex items-center gap-1">
                  <button
                    onClick={() => navigate(crumb)}
                    className={`px-1.5 py-0.5 rounded ${
                      isLast
                        ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
                    }`}
                  >
                    {label}
                  </button>
                  {!isLast && <span className="text-[var(--color-ink-muted)]">/</span>}
                </span>
              );
            })}
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-auto py-1">
          {loading && (
            <p className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">Loading…</p>
          )}
          {error && <p className="px-4 py-2 text-xs text-red-400">{error}</p>}
          {browse && browse.parent && (
            <button
              onClick={() => navigate(browse.parent!)}
              className="w-full flex items-center gap-2 px-4 py-1.5 text-sm text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]"
            >
              <span className="w-4">↑</span>
              <span>.. (parent)</span>
            </button>
          )}
          {browse?.entries.map((entry, i) => {
            const active = i === focusIndex;
            return (
              <button
                key={entry.name}
                onClick={() =>
                  navigate(`${browse.path === '/' ? '' : browse.path}/${entry.name}`)
                }
                onMouseEnter={() => setFocusIndex(i)}
                className={`w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm ${
                  active ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-3)]/60'
                }`}
              >
                <span className="w-4">📁</span>
                <span className={entry.hidden ? 'opacity-60' : ''}>{entry.name}</span>
              </button>
            );
          })}
          {browse && browse.entries.length === 0 && (
            <p className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">
              No subdirectories.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-3 flex items-center justify-between">
          <label className="text-xs text-[var(--color-ink-muted)] flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!browse}
              className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            >
              Select this directory
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
