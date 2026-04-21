import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  className?: string;
  placeholder?: string;
  title?: string;
}

export function EditableTitle({
  value,
  onSave,
  className = '',
  placeholder = 'Untitled',
  title = 'Click to rename',
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    if (next && next !== value) {
      try {
        await onSave(next);
      } catch {
        // fall through; editing closes anyway
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className={`bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1.5 py-0.5 outline-none focus:border-[var(--color-accent)] ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={title}
      className={`text-left hover:text-[var(--color-accent)] ${className}`}
    >
      {value || placeholder}
    </button>
  );
}
