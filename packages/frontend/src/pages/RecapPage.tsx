import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { Sparkles, FileText, Copy, Check } from 'lucide-react';
import { api } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';
import { copyText } from '../utils/download.js';
import { setRecap, useRecapStore, type Lang } from '../stores/recapStore.js';
import { useState } from 'react';
import { useT } from '../i18n/t.js';

// Phase 4 — RAG answers over the corpus + portfolio/résumé generation. State
// lives in a module store (recapStore) so a long in-flight LLM call and its
// result survive navigating away and back.
export function RecapPage() {
  const t = useT();
  const { data: projects } = useSWR('recap:projects', () => api.listProjects());
  const { data: groups = [] } = useSWR('project-groups', () => api.listProjectGroups());
  const s = useRecapStore();
  const [copied, setCopied] = useState(false);

  async function ask() {
    const q = s.question.trim();
    if (!q || s.asking) return;
    setRecap({ asking: true, askResult: null });
    try {
      const r = await api.recapAsk(q, s.askProject || undefined, s.askLang, s.askGroup || undefined);
      setRecap({ askResult: r });
    } catch (e) {
      setRecap({ askResult: { answer: `Error: ${String(e)}`, sources: [] } });
    } finally {
      setRecap({ asking: false });
    }
  }

  async function generate() {
    if (s.generating) return;
    setRecap({ generating: true, genResult: null });
    try {
      const r = await api.recapGenerate({
        kind: s.kind,
        dateFrom: s.from,
        dateTo: s.to,
        projectId: s.genProject || undefined,
        language: s.genLang,
      });
      setRecap({ genResult: r.empty ? '__EMPTY__' : r.markdown });
    } catch (e) {
      setRecap({ genResult: `Error: ${String(e)}` });
    } finally {
      setRecap({ generating: false });
    }
  }

  async function copyOut() {
    if (!s.genResult || s.genResult === '__EMPTY__') return;
    await copyText(s.genResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const inputCls =
    'text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1';
  const btnCls =
    'flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50';
  const LangSel = ({ value, onChange }: { value: Lang; onChange: (l: Lang) => void }) => (
    <select value={value} onChange={(e) => onChange(e.target.value as Lang)} className={inputCls} title={t('page.recap.outputLanguage')}>
      <option value="ko">{t('page.recap.lang.ko')}</option>
      <option value="en">{t('page.recap.lang.en')}</option>
    </select>
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 space-y-6 max-w-3xl">
      {/* ---- Ask ---- */}
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold mb-2">
          <Sparkles size={15} /> {t('page.recap.ask.title')}
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          {t('page.recap.ask.desc')}
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <input
            value={s.question}
            onChange={(e) => setRecap({ question: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void ask()}
            placeholder={t('page.recap.questionPlaceholder')}
            className={`${inputCls} flex-1 min-w-[200px]`}
          />
          <select
            value={s.askProject}
            onChange={(e) => setRecap({ askProject: e.target.value })}
            className={inputCls}
            title={t('page.recap.scopeProject')}
          >
            <option value="">{t('page.recap.allProjects')}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {groups.length > 0 && (
            <select
              value={s.askGroup}
              onChange={(e) => setRecap({ askGroup: e.target.value })}
              className={inputCls}
              title={t('page.recap.scopeGroup')}
            >
              <option value="">{t('page.recap.anyGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="__ungrouped__">{t('page.recap.ungrouped')}</option>
            </select>
          )}
          <LangSel value={s.askLang} onChange={(l) => setRecap({ askLang: l })} />
          <button onClick={() => void ask()} disabled={s.asking || !s.question.trim()} className={btnCls}>
            {s.asking ? t('page.recap.searching') : t('page.recap.askButton')}
          </button>
        </div>
        {(s.asking || s.askResult) && (
          <div className="mt-3 rounded border border-[var(--color-border)] p-3">
            {s.asking ? (
              <div className="text-sm text-[var(--color-ink-muted)]">{t('page.recap.searchingHint')}</div>
            ) : (
              <>
                <Markdown content={s.askResult!.answer} />
                {s.askResult!.sources.length > 0 && (
                  <div className="mt-3 border-t border-[var(--color-border)] pt-2">
                    <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
                      {t('page.recap.sources')}
                    </div>
                    <ul className="space-y-0.5">
                      {s.askResult!.sources.map((src) =>
                        src.kind === 'timeline' ? (
                          <li key={src.n} className="text-xs">
                            <Link
                              to="/timeline"
                              onClick={() => {
                                try {
                                  localStorage.setItem('pinloom:timeline:project', src.projectId);
                                  localStorage.setItem('pinloom:timeline:date', src.date);
                                } catch {
                                  // ignore
                                }
                              }}
                              className="text-[var(--color-accent)] hover:underline"
                            >
                              [{src.n}] 🗓 {src.projectName} · {src.date}
                            </Link>
                          </li>
                        ) : src.kind === 'wiki' ? (
                          <li key={src.n} className="text-xs">
                            <Link
                              to={`/wiki/${encodeURIComponent(`${src.slug}.md`)}`}
                              className="text-[var(--color-accent)] hover:underline"
                            >
                              [{src.n}] 📖 {src.title}
                            </Link>
                          </li>
                        ) : (
                          <li key={src.n} className="text-xs">
                            <Link to={`/s/${src.sessionId}`} className="text-[var(--color-accent)] hover:underline">
                              [{src.n}] {src.projectName} · {src.sessionTitle ?? t('page.recap.sessionFallback')} · {src.createdAt.slice(0, 10)}
                            </Link>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* ---- Generate ---- */}
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold mb-2">
          <FileText size={15} /> {t('page.recap.gen.title')}
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          {t('page.recap.gen.desc')}
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <select value={s.kind} onChange={(e) => setRecap({ kind: e.target.value as 'detailed' | 'concise' })} className={inputCls}>
            <option value="detailed">{t('page.recap.gen.detailed')}</option>
            <option value="concise">{t('page.recap.gen.concise')}</option>
          </select>
          <input type="date" value={s.from} onChange={(e) => setRecap({ from: e.target.value })} className={inputCls} />
          <span className="text-xs text-[var(--color-ink-muted)]">~</span>
          <input type="date" value={s.to} onChange={(e) => setRecap({ to: e.target.value })} className={inputCls} />
          <select value={s.genProject} onChange={(e) => setRecap({ genProject: e.target.value })} className={inputCls}>
            <option value="">{t('page.recap.allProjects')}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <LangSel value={s.genLang} onChange={(l) => setRecap({ genLang: l })} />
          <button onClick={() => void generate()} disabled={s.generating} className={btnCls}>
            {s.generating ? t('page.recap.generating') : t('page.recap.generateButton')}
          </button>
        </div>
        {(s.generating || s.genResult) && (
          <div className="mt-3 rounded border border-[var(--color-border)] p-3 relative">
            {s.generating ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                {t('page.recap.compiling')}
              </div>
            ) : s.genResult === '__EMPTY__' ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                {t('page.recap.genEmpty')}
              </div>
            ) : (
              <>
                <button
                  onClick={() => void copyOut()}
                  title={t('page.recap.copy')}
                  className="absolute top-2 right-2 p-1 rounded border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <Markdown content={s.genResult!} />
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
