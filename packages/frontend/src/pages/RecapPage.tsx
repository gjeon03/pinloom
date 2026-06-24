import { useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { Sparkles, FileText, Copy, Check } from 'lucide-react';
import { api } from '../api/client.js';
import { Markdown } from '../components/Markdown.js';
import { copyText } from '../utils/download.js';

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type AskResult = Awaited<ReturnType<typeof api.recapAsk>>;

// Phase 4 — RAG answers over the corpus + portfolio/résumé generation from the
// Work Timeline. Two panels: Ask (grounded answer + citations) and Generate.
export function RecapPage() {
  const { data: projects } = useSWR('recap:projects', () => api.listProjects());

  // --- Ask ---
  const [question, setQuestion] = useState('');
  const [askProject, setAskProject] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await api.recapAsk(q, askProject || undefined));
    } catch (e) {
      setAnswer({ answer: `오류: ${String(e)}`, sources: [] });
    } finally {
      setAsking(false);
    }
  }

  // --- Generate ---
  const [kind, setKind] = useState<'portfolio' | 'resume'>('portfolio');
  const [from, setFrom] = useState(monthsAgo(3));
  const [to, setTo] = useState(today());
  const [genProject, setGenProject] = useState('');
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function generate() {
    if (generating) return;
    setGenerating(true);
    setOutput(null);
    try {
      const r = await api.recapGenerate({
        kind,
        dateFrom: from,
        dateTo: to,
        projectId: genProject || undefined,
      });
      setOutput(r.empty ? '__EMPTY__' : r.markdown);
    } catch (e) {
      setOutput(`오류: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  }
  async function copyOut() {
    if (!output || output === '__EMPTY__') return;
    await copyText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const inputCls =
    'text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1';
  const btnCls =
    'flex items-center gap-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50';

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 space-y-6 max-w-3xl">
      {/* ---- Ask ---- */}
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold mb-2">
          <Sparkles size={15} /> 내 기록에 물어보기
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          과거 대화에서 근거를 찾아 답합니다. 예: "빌링 작업할 때 무슨 고민을 했지?"
        </p>
        <div className="flex gap-2 items-center">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void ask()}
            placeholder="질문…"
            className={`${inputCls} flex-1`}
          />
          <select value={askProject} onChange={(e) => setAskProject(e.target.value)} className={inputCls}>
            <option value="">전체 프로젝트</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void ask()} disabled={asking || !question.trim()} className={btnCls}>
            {asking ? '찾는 중…' : '물어보기'}
          </button>
        </div>
        {answer && (
          <div className="mt-3 rounded border border-[var(--color-border)] p-3">
            <Markdown content={answer.answer} />
            {answer.sources.length > 0 && (
              <div className="mt-3 border-t border-[var(--color-border)] pt-2">
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
                  근거
                </div>
                <ul className="space-y-0.5">
                  {answer.sources.map((s) => (
                    <li key={s.n} className="text-xs">
                      <Link
                        to={`/s/${s.sessionId}`}
                        className="text-[var(--color-accent)] hover:underline"
                      >
                        [{s.n}] {s.projectName} · {s.sessionTitle ?? '세션'} ·{' '}
                        {s.createdAt.slice(0, 10)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---- Generate ---- */}
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold mb-2">
          <FileText size={15} /> 포트폴리오 / 이력서 생성
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)] mb-2">
          작업 타임라인(자동 기록)에서 기간 내 작업을 모아 작성합니다.
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'portfolio' | 'resume')} className={inputCls}>
            <option value="portfolio">포트폴리오</option>
            <option value="resume">이력서 불릿</option>
          </select>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          <span className="text-xs text-[var(--color-ink-muted)]">~</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          <select value={genProject} onChange={(e) => setGenProject(e.target.value)} className={inputCls}>
            <option value="">전체 프로젝트</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void generate()} disabled={generating} className={btnCls}>
            {generating ? '생성 중…' : '생성'}
          </button>
        </div>
        {output && (
          <div className="mt-3 rounded border border-[var(--color-border)] p-3 relative">
            {output === '__EMPTY__' ? (
              <div className="text-sm text-[var(--color-ink-muted)]">
                이 기간에 정리된 작업이 없어요. 타임라인이 쌓이면 다시 시도하세요.
              </div>
            ) : (
              <>
                <button
                  onClick={() => void copyOut()}
                  title="복사"
                  className="absolute top-2 right-2 p-1 rounded border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <Markdown content={output} />
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
