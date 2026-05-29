import { useEffect, useRef, useState } from 'react';
import { NotepadText, X } from 'lucide-react';
import { api } from '../api/client.js';

// Global scratchpad. A fixed top-right icon (between the GitHub link and the
// notification bell) opens a right slide-over with a single shared note,
// persisted to the GitHub-backed sqlite via /api/notepad. Loads lazily on
// first open; autosaves (debounced) so closing/reloading never loses edits.
export function Notepad() {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    api
      .getNotepad()
      .then((r) => {
        if (!cancelled) {
          setContent(r.content);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  // Debounced autosave — only fires on genuine edits (dirtyRef), so the
  // initial load's setContent doesn't trigger a write-back.
  useEffect(() => {
    if (!loaded || !dirtyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      api
        .saveNotepad(content)
        .catch(() => {
          // best-effort; the next keystroke retries
        })
        .finally(() => {
          setSaving(false);
          dirtyRef.current = false;
        });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, loaded]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Notepad"
        className="fixed top-3 right-[52px] z-40 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 backdrop-blur-sm p-2 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] shadow-md inline-flex items-center justify-center"
      >
        <NotepadText size={14} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed top-0 right-0 z-50 flex h-full w-[360px] max-w-[90vw] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <NotepadText size={14} />
                Notepad
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {saving ? 'saving…' : loaded ? 'saved' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Close"
                  className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <textarea
              autoFocus
              value={content}
              onChange={(e) => {
                dirtyRef.current = true;
                setContent(e.target.value);
              }}
              placeholder="Quick notes… (saved to the GitHub-backed DB)"
              className="flex-1 resize-none bg-[var(--color-surface)] px-4 py-3 text-sm font-mono leading-relaxed outline-none"
            />
          </div>
        </>
      )}
    </>
  );
}
