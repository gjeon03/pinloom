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
import { TIMELINE_VECTORS } from './timeline/indexer.js';
import { getVectorMeta, knn } from './vector-store.js';
import { isVectorAvailable } from '../db/connection.js';

const DEFAULT_RECAP_MODEL = 'claude-sonnet-4-6';
const RECAP_TIMEOUT_MS = 5 * 60_000;
const ANSWER_HITS = 12;
const TIMELINE_HITS = 8;
const RRF_K = 60; // reciprocal-rank-fusion constant (matches message-search)
const PER_MESSAGE_CAP = 4000; // chars per hydrated message / timeline entry
const ANSWER_CONTEXT_BUDGET = 60_000;
const TIMELINE_BUDGET = 100_000; // concatenated timeline markdown for 4B

// docId for timeline vectors is `${projectId}:${date}` with date a fixed
// YYYY-MM-DD; split off the trailing ":YYYY-MM-DD" so a projectId is recovered
// verbatim regardless of its characters.
function splitTimelineDocId(docId: string): { projectId: string; date: string } {
  return { projectId: docId.slice(0, -11), date: docId.slice(-10) };
}

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

type MessageSourceData = {
  kind: 'message';
  messageId: string;
  sessionId: string;
  sessionTitle: string | null;
  projectName: string;
  createdAt: string;
};
type TimelineSourceData = {
  kind: 'timeline';
  projectId: string;
  projectName: string;
  date: string;
};
type RecapSourceData = MessageSourceData | TimelineSourceData;
export type RecapSource = RecapSourceData & { n: number };
export interface CorpusAnswer {
  answer: string;
  sources: RecapSource[];
}

export type RecapLanguage = 'ko' | 'en';
function langLine(lang: RecapLanguage): string {
  return lang === 'en' ? 'Write your output in English.' : 'Write your output in Korean.';
}

function answerSystem(lang: RecapLanguage): string {
  return `You answer a developer's question using ONLY the numbered context excerpts from their own past coding conversations and dated work-journal entries. Each excerpt is tagged [n]. Ground every claim in the excerpts and CITE the ones you use inline as [n]. If the excerpts don't contain the answer, say so plainly — never invent. Be concise. ${langLine(lang)}`;
}

// One ranked candidate before budget-filling. `rrf` is the reciprocal-rank score
// used to interleave the two independently-ranked arms (messages, timeline) into
// a single relevance order — so the timeline arm never steals a fixed quota from
// messages (review M3).
type Candidate = {
  rrf: number;
  content: string;
  source: RecapSourceData;
  label: string;
};

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
  const provider = opts.provider ?? null;
  const candidates: Candidate[] = [];

  // --- arm 1: messages (hybrid FTS + vector) ---
  const hits = await searchMessagesHybrid(
    db,
    q,
    { projectId: opts.projectId, limit: opts.limit ?? ANSWER_HITS },
    provider,
  );
  const contentStmt = db.prepare('SELECT content FROM messages WHERE id = ?');
  hits.forEach((h, i) => {
    const row = contentStmt.get(h.messageId) as { content: string } | undefined;
    candidates.push({
      rrf: 1 / (RRF_K + i),
      content: (row?.content ?? h.excerpt).slice(0, PER_MESSAGE_CAP),
      label: `${h.projectName} · ${h.sessionTitle ?? 'session'} · ${h.createdAt}`,
      source: {
        kind: 'message',
        messageId: h.messageId,
        sessionId: h.sessionId,
        sessionTitle: h.sessionTitle,
        projectName: h.projectName,
        createdAt: h.createdAt,
      },
    });
  });

  // --- arm 2: timeline (vector only) — guarded on a SHARED vector space so we
  // never fuse distances from a different embedding model (review M2). ---
  const tlMeta = isVectorAvailable() ? getVectorMeta(db, TIMELINE_VECTORS) : null;
  if (provider && tlMeta && tlMeta.modelId === provider.id) {
    try {
      const qvec = await provider.embedQuery(q);
      const k = Math.min(opts.projectId ? TIMELINE_HITS * 4 : TIMELINE_HITS * 2, 100);
      const nameStmt = db.prepare('SELECT name FROM projects WHERE id = ?');
      const tlHits = knn(db, TIMELINE_VECTORS, qvec, k)
        .map((hit) => splitTimelineDocId(hit.docId))
        .filter((t) => !opts.projectId || t.projectId === opts.projectId)
        .slice(0, TIMELINE_HITS);
      tlHits.forEach((t, i) => {
        const content = readEntry(getProjectWikiSlugByProjectId(t.projectId), t.date);
        if (!content) return; // file gone since indexing
        const projectName =
          (nameStmt.get(t.projectId) as { name: string } | undefined)?.name ?? t.projectId;
        candidates.push({
          rrf: 1 / (RRF_K + i),
          content: content.slice(0, PER_MESSAGE_CAP),
          label: `work journal · ${projectName} · ${t.date}`,
          source: { kind: 'timeline', projectId: t.projectId, projectName, date: t.date },
        });
      });
    } catch {
      // embed/knn failure → degrade to messages-only
    }
  }

  if (candidates.length === 0) {
    return { answer: '관련된 기록을 찾지 못했어요.', sources: [] };
  }

  // Single relevance order, single budget filled greedily, [n] numbered across
  // the merge — no per-arm reservation.
  candidates.sort((a, b) => b.rrf - a.rrf);
  const sources: RecapSource[] = [];
  const promptChunks: string[] = [];
  let budget = ANSWER_CONTEXT_BUDGET;
  for (const c of candidates) {
    if (budget <= 0) break;
    const n = sources.length + 1;
    budget -= c.content.length;
    sources.push({ ...c.source, n } as RecapSource);
    promptChunks.push(`[${n}] (${c.label})\n${c.content}`);
  }

  const prompt = [`Question: ${q}`, '', 'Context excerpts:', ...promptChunks].join('\n\n');
  const answer = await (opts.runRecap ?? defaultRunRecap)(
    prompt,
    answerSystem(opts.language ?? 'ko'),
    opts.model ?? DEFAULT_RECAP_MODEL,
  );
  return { answer: answer.trim(), sources };
}

// ---------------------------------------------------- 4B: work highlights ----
// One artifact ("Work highlights"), two depths — the old portfolio/résumé split
// confused more than it helped (the user couldn't tell them apart).

export type RecapKind = 'detailed' | 'concise';

function recapSystem(kind: RecapKind, lang: RecapLanguage): string {
  if (kind === 'concise') {
    return `You distill a developer's dated WORK JOURNAL entries into a tight, scannable highlights list — the notable work only, impact-first, action verbs, quantified where the entries support it. Group by project. Use ONLY what the entries state; never invent metrics. Output markdown bullets only, a few per project. ${langLine(lang)}`;
  }
  return `You distill a developer's dated WORK JOURNAL entries into detailed work highlights — for each notable piece of work: a short title, what was built and WHY (the reasoning the entries captured), and the outcome. Group by project. Use ONLY the entries; never invent. Output markdown with a short paragraph or sub-bullets per item. ${langLine(lang)}`;
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
