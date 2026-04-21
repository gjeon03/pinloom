import { useState } from 'react';
import type { Message } from '@pinloom/shared';
import { api } from '../api/client.js';

interface Props {
  pins: Message[];
  onChange: (message: Message) => void;
}

export function PinnedPanel({ pins, onChange }: Props) {
  return (
    <aside className="h-full w-full border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
      <header className="border-b border-[var(--color-border)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
        Pinned ({pins.length})
      </header>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {pins.map((pin) => (
          <PinCard key={pin.id} pin={pin} onChange={onChange} />
        ))}
      </div>
    </aside>
  );
}

function PinCard({ pin, onChange }: { pin: Message; onChange: (m: Message) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pin.pinTitle ?? '');
  const [collapsed, setCollapsed] = useState(false);

  async function saveTitle() {
    const next = title.trim() || null;
    const updated = await api.updateMessage(pin.id, { pinTitle: next });
    onChange(updated);
    setEditing(false);
  }

  async function unpin() {
    const updated = await api.updateMessage(pin.id, { pinned: false });
    onChange(updated);
  }

  return (
    <article className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <header className="flex items-center gap-2 mb-1">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') {
                setTitle(pin.pinTitle ?? '');
                setEditing(false);
              }
            }}
            className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-2 py-0.5 text-sm"
          />
        ) : (
          <button
            onClick={() => {
              setTitle(pin.pinTitle ?? '');
              setEditing(true);
            }}
            className="flex-1 truncate text-left text-sm font-medium hover:text-[var(--color-accent)]"
            title="Click to edit title"
          >
            {pin.pinTitle ?? '(untitled pin)'}
          </button>
        )}
        <button
          onClick={unpin}
          title="Unpin"
          className="text-[var(--color-accent)] hover:text-red-400"
        >
          📌
        </button>
      </header>
      {!collapsed && (
        <div className="whitespace-pre-wrap text-sm text-[var(--color-ink)]/90 border-t border-[var(--color-border)] pt-2 mt-1 max-h-96 overflow-auto">
          {pin.content}
        </div>
      )}
    </article>
  );
}
