// Corpus recap (docs/knowledge-system-v3.md §5 ④, Phase 4). Two LLM features
// over the accumulated corpus, both behind an injectable `RunRecap` seam (the
// wiki-gardener / distill pattern — real SDK default, unit-testable with a fake):
//
//  - answerOverCorpus  (4A): RAG Q&A over MESSAGES. Retrieves via the existing
//    hybrid search, HYDRATES full message content (excerpts are too thin to
//    ground on — review H1), feeds numbered chunks to the LLM, returns the
//    answer + the chunk→source map for citation links. Messages-only for now
//    (timeline vector-indexing is a fast-follow — review H2).
//  - generateRecap     (4B): portfolio / résumé from the Work Timeline. No
//    retrieval — reads the dated L1 entries in a range directly (timeline IS the
//    "what I did" source), char-budget bounded.
//
// Distinct from ⌘K search (returns hits, not answers) and the gardener (proposes
// wiki edits). Degrade-safe: empty corpus → graceful, never throws into a request.

import type { Database } from 'better-sqlite3';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { searchMessagesHybrid } from './message-search.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { listDates, readEntry } from './timeline/store.js';

const DEFAULT_RECAP_MODEL = 'claude-sonnet-4-6';
const RECAP_TIMEOUT_MS = 5 * 60_000;
const ANSWER_HITS = 12;
const PER_MESSAGE_CAP = 4000; // chars per hydrated message
const ANSWER_CONTEXT_BUDGET = 60_000;
const TIMELINE_BUDGET = 100_000; // concatenated timeline markdown for 4B

// prompt + system → text. Injectable for tests.
export type RunRecap = (prompt: string, system: string, model: string) => Promise<string>;

const defaultRunRecap: RunRecap = async (prompt, system, model) => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), RECAP_TIMEOUT_MS);
  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      model,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowedTools: [],
      abortController,
    } as Parameters<typeof query>[0]['options'],
  });
  let out = '';
  try {
    for await (const message of q) {
      const m = message as unknown as {
        type: string;
        message?: { content?: Array<{ type: string; text?: string }> };
        result?: string;
        subtype?: string;
      };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) out = block.text;
        }
      } else if (m.type === 'result' && m.subtype === 'success' && m.result) {
        if (m.result.length > out.length) out = m.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
};

// ---------------------------------------------------------------- 4A: Q&A ----

export interface RecapSource {
  n: number;
  messageId: string;
  sessionId: string;
  sessionTitle: string | null;
  projectName: string;
  createdAt: string;
}
export interface CorpusAnswer {
  answer: string;
  sources: RecapSource[];
}

export type RecapLanguage = 'ko' | 'en';
function langLine(lang: RecapLanguage): string {
  return lang === 'en' ? 'Write your output in English.' : 'Write your output in Korean.';
}

function answerSystem(lang: RecapLanguage): string {
  return `You answer a developer's question using ONLY the numbered context excerpts from their own past coding conversations. Each excerpt is tagged [n]. Ground every claim in the excerpts and CITE the ones you use inline as [n]. If the excerpts don't contain the answer, say so plainly — never invent. Be concise. ${langLine(lang)}`;
}

export async function answerOverCorpus(
  db: Database,
  question: string,
  opts: {
    projectId?: string;
    provider?: EmbeddingProvider | null;
    limit?: number;
    runRecap?: RunRecap;
    model?: string;
    language?: RecapLanguage;
  } = {},
): Promise<CorpusAnswer> {
  const q = question.trim();
  if (!q) return { answer: '질문이 비어 있어요.', sources: [] };

  const hits = await searchMessagesHybrid(
    db,
    q,
    { projectId: opts.projectId, limit: opts.limit ?? ANSWER_HITS },
    opts.provider ?? null,
  );
  if (hits.length === 0) {
    return { answer: '관련된 기록을 찾지 못했어요.', sources: [] };
  }

  // Hydrate FULL message content (the 160-char excerpt is too thin to ground on).
  const contentStmt = db.prepare('SELECT content FROM messages WHERE id = ?');
  const chunks: (RecapSource & { content: string })[] = [];
  let budget = ANSWER_CONTEXT_BUDGET;
  for (const h of hits) {
    if (budget <= 0) break;
    const row = contentStmt.get(h.messageId) as { content: string } | undefined;
    const content = (row?.content ?? h.excerpt).slice(0, PER_MESSAGE_CAP);
    budget -= content.length;
    chunks.push({
      n: chunks.length + 1,
      messageId: h.messageId,
      sessionId: h.sessionId,
      sessionTitle: h.sessionTitle,
      projectName: h.projectName,
      createdAt: h.createdAt,
      content,
    });
  }

  const prompt = [
    `Question: ${q}`,
    '',
    'Context excerpts:',
    ...chunks.map(
      (c) =>
        `[${c.n}] (${c.projectName} · ${c.sessionTitle ?? 'session'} · ${c.createdAt})\n${c.content}`,
    ),
  ].join('\n\n');

  const answer = await (opts.runRecap ?? defaultRunRecap)(
    prompt,
    answerSystem(opts.language ?? 'ko'),
    opts.model ?? DEFAULT_RECAP_MODEL,
  );
  // strip content from the returned sources (UI only needs the link metadata)
  const sources: RecapSource[] = chunks.map(({ content: _c, ...s }) => s);
  return { answer: answer.trim(), sources };
}

// ------------------------------------------------- 4B: portfolio / résumé ----

export type RecapKind = 'portfolio' | 'resume';

function recapSystem(kind: RecapKind, lang: RecapLanguage): string {
  if (kind === 'resume') {
    return `You turn a developer's dated WORK JOURNAL entries into concise résumé bullet points — impact-first, action verbs, quantified where the entries support it. Group by project. Use ONLY what the entries state; never invent metrics. Output markdown bullets only. ${langLine(lang)}`;
  }
  return `You turn a developer's dated WORK JOURNAL entries into PORTFOLIO items — for each notable piece of work: a short title, what was built and why (the reasoning the entries captured), and the outcome. Use ONLY the entries; never invent. Output markdown. ${langLine(lang)}`;
}

// Gather timeline markdown in a date range (newest first), char-budget bounded.
function gatherTimeline(
  db: Database,
  dateFrom: string,
  dateTo: string,
  projectId: string | undefined,
): { text: string; truncated: boolean } {
  const projects = projectId
    ? (db.prepare('SELECT id, name FROM projects WHERE id = ?').all(projectId) as {
        id: string;
        name: string;
      }[])
    : (db.prepare('SELECT id, name FROM projects WHERE hidden = 0').all() as {
        id: string;
        name: string;
      }[]);
  const parts: string[] = [];
  let budget = TIMELINE_BUDGET;
  let truncated = false;
  for (const p of projects) {
    const slug = getProjectWikiSlugByProjectId(p.id);
    const dates = listDates(slug).filter((d) => d >= dateFrom && d <= dateTo); // newest first
    for (const d of dates) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const md = readEntry(slug, d);
      if (!md) continue;
      const block = `## ${p.name} — ${d}\n\n${md}`;
      parts.push(block.slice(0, Math.max(budget, 0)));
      budget -= block.length;
    }
    if (budget <= 0) truncated = true;
  }
  return { text: parts.join('\n\n---\n\n'), truncated };
}

export interface RecapResult {
  markdown: string;
  /** True if there were no timeline entries in range. */
  empty: boolean;
}

export async function generateRecap(
  db: Database,
  opts: {
    kind: RecapKind;
    dateFrom: string;
    dateTo: string;
    projectId?: string;
    runRecap?: RunRecap;
    model?: string;
    language?: RecapLanguage;
  },
): Promise<RecapResult> {
  const { text, truncated } = gatherTimeline(db, opts.dateFrom, opts.dateTo, opts.projectId);
  if (text.trim() === '') return { markdown: '', empty: true };

  const prompt = [
    `Date range: ${opts.dateFrom} … ${opts.dateTo}`,
    truncated ? '(note: older entries were truncated to fit)' : '',
    '',
    'Work journal entries:',
    text,
  ]
    .filter(Boolean)
    .join('\n');

  const markdown = await (opts.runRecap ?? defaultRunRecap)(
    prompt,
    recapSystem(opts.kind, opts.language ?? 'ko'),
    opts.model ?? DEFAULT_RECAP_MODEL,
  );
  return { markdown: markdown.trim(), empty: false };
}
