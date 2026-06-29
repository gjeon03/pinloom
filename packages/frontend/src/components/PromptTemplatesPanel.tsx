import { useState } from 'react';
import useSWR from 'swr';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { copyText } from '../utils/download.js';
import { useT } from '../i18n/t.js';

interface Draft {
  id?: string;
  title: string;
  body: string;
}

// Right-docked panel listing your prompt templates: expand to read, copy the
// body to paste anywhere. The composer's `/` insertion only works in SDK mode,
// so copy makes templates usable in terminal sessions too. Edit/add/delete live
// here (moved out of Settings).
export function PromptTemplatesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { data: items, mutate: refresh } = useSWR(
    cacheKeys.promptTemplates(),
    () => api.listPromptTemplates(),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!draft) return;
    if (!draft.title.trim()) return setError(t('cmp.templates.titleRequired'));
    if (!draft.body.trim()) return setError(t('cmp.templates.bodyRequired'));
    setBusy(true);
    try {
      if (draft.id) {
        await api.updatePromptTemplate(draft.id, {
          title: draft.title.trim(),
          body: draft.body,
        });
      } else {
        await api.createPromptTemplate({ title: draft.title.trim(), body: draft.body });
      }
      setDraft(null);
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, title: string) {
    if (!confirm(t('cmp.templates.deleteConfirm', { title }))) return;
    setBusy(true);
    try {
      await api.deletePromptTemplate(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(id: string, body: string) {
    await copyText(body);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  }

  const iconBtn =
    'rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]';

  return (
    <div className="relative flex h-full w-80 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="text-sm font-semibold">{t('cmp.templates.title')}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setDraft({ title: '', body: '' });
              setError(null);
            }}
            title={t('cmp.templates.add')}
            className={iconBtn}
          >
            <Plus size={15} />
          </button>
          <button type="button" onClick={onClose} title={t('cmp.templates.close')} aria-label={t('cmp.templates.close')} className={iconBtn}>
            <X size={15} />
          </button>
        </div>
      </header>

      {draft && (
        <div className="border-b border-[var(--color-border)] p-3 space-y-2">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={t('cmp.templates.titlePlaceholder')}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-sm"
          />
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={t('cmp.templates.bodyPlaceholder')}
            rows={5}
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs font-mono"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="rounded px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]"
            >
              {t('cmp.templates.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-black disabled:opacity-40"
            >
              {t('cmp.templates.save')}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!items ? (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">{t('cmp.templates.loading')}</p>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">
            {t('cmp.templates.emptyBefore')}
            <code>/</code>
            {t('cmp.templates.emptyAfter')}
          </p>
        ) : (
          items.map((tpl) => {
            const open = expanded === tpl.id;
            return (
              <div key={tpl.id} className="border-b border-[var(--color-border)]">
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : tpl.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                  >
                    {open ? (
                      <ChevronDown size={13} className="shrink-0 text-[var(--color-ink-muted)]" />
                    ) : (
                      <ChevronRight size={13} className="shrink-0 text-[var(--color-ink-muted)]" />
                    )}
                    <span className="truncate">{tpl.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void copy(tpl.id, tpl.body)}
                    title={t('cmp.templates.copy')}
                    className={iconBtn}
                  >
                    {copiedId === tpl.id ? (
                      <Check size={14} className="text-[var(--color-accent)]" />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                </div>
                {open && (
                  <div className="px-3 pb-2">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-3)] p-2 text-xs font-mono">
                      {tpl.body}
                    </pre>
                    <div className="mt-1.5 flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setDraft({ id: tpl.id, title: tpl.title, body: tpl.body });
                          setError(null);
                        }}
                        title={t('cmp.templates.edit')}
                        className={iconBtn}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(tpl.id, tpl.title)}
                        title={t('cmp.templates.delete')}
                        className={iconBtn}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
