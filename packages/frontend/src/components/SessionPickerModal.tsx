import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';

interface Props {
  pin: Message;
  projectId: string;
  sessions: Session[];
  currentSessionId: string;
  onClose: () => void;
  onSent?: (targetSessionId: string) => void;
  onNewSessionCreated?: (session: Session) => void;
}

export function SessionPickerModal({
  pin,
  projectId,
  sessions,
  currentSessionId,
  onClose,
  onSent,
  onNewSessionCreated,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendTo(target: Session) {
    setBusyId(target.id);
    setError(null);
    try {
      await api.injectPin(target.id, pin.id);
      setSentId(target.id);
      onSent?.(target.id);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function sendToNew() {
    setBusyId('__new__');
    setError(null);
    try {
      const created = await api.createSession(projectId, { title: 'New chat' });
      onNewSessionCreated?.(created);
      await api.injectPin(created.id, pin.id);
      setSentId(created.id);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const others = sessions.filter((s) => s.id !== currentSessionId);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col cursor-default"
        style={{ maxHeight: 'min(560px, 80vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Send pin to…</h2>
            <p className="text-[11px] text-[var(--color-ink-muted)] truncate max-w-[320px]">
              {pin.pinTitle ?? '(untitled pin)'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto py-1">
          <button
            onClick={sendToNew}
            disabled={busyId !== null}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          >
            <Plus size={14} className="text-[var(--color-accent)] shrink-0" />
            <span className="flex-1">Create new session</span>
            {sentId === '__new__' && <Check size={14} className="text-emerald-400" />}
          </button>

          {others.length > 0 && (
            <div className="mt-1 border-t border-[var(--color-border)] pt-1">
              {others.map((s) => {
                const label = s.title ?? `Chat ${s.id.slice(0, 6)}`;
                const busy = busyId === s.id;
                const sent = sentId === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => sendTo(s)}
                    disabled={busyId !== null}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-[var(--color-surface-3)] disabled:opacity-50"
                  >
                    <span className="flex-1 truncate">{label}</span>
                    {busy && (
                      <span className="text-[10px] text-[var(--color-ink-muted)]">sending…</span>
                    )}
                    {sent && <Check size={14} className="text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          )}

          {others.length === 0 && (
            <p className="px-4 py-3 text-xs text-[var(--color-ink-muted)] text-center">
              No other sessions in this project. Use "Create new session" above.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-ink-muted)]">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : (
            <span>Pin content will be injected into the target session's next AI response.</span>
          )}
        </div>
      </div>
    </div>
  );
}
