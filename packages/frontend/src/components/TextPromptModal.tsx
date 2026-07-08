import { useEffect, useRef, useState } from 'react';

// A small single-line text-input modal — a cross-platform replacement for
// `window.prompt()`, which Electron does NOT implement (it silently returns
// null, so any button wired to prompt() appears dead in the desktop app while
// working in a browser). Controlled by the caller: render it conditionally and
// handle onSubmit/onCancel.
interface Props {
  title: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Called with the trimmed, non-empty value. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function TextPromptModal({
  title,
  placeholder,
  initial = '',
  submitLabel = 'OK',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function submit() {
    const v = value.trim();
    if (!v) {
      onCancel();
      return;
    }
    onSubmit(v);
  }

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[20vh] cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 cursor-default"
      >
        <label className="block text-sm font-medium text-[var(--color-ink)]">
          {title}
        </label>
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
