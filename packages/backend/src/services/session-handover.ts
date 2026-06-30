// Session handover doc generator. Distills ONE session into a handover document
// for a human successor: a structured summary on top + a detailed, day-by-day
// account underneath. The day-by-day pass deliberately preserves the *reasoning*
// (why a decision was made, alternatives weighed, dead-ends, gotchas) — a clean
// summary alone drops exactly the tacit knowledge a handover needs to transfer.
//
// NOTE: distinct from handoff.ts, which FORKS a session into a fresh one. This
// produces a read-only document for a person, not a new session.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb } from '../db/connection.js';
import { localDateOf } from './timeline/capture.js';
import { getUiConfig } from './ui-config.js';
import type { UiLocale } from '@pinloom/shared';

const MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 5 * 60_000;
// SMALL per-request transcript window. Each distill call gets at most this many
// chars so the model reliably finishes in-budget — stuffing a whole busy day
// into one prompt is what made the model run past maxTurns and 500. A long day
// is split into several of these windows and distilled separately.
const CHUNK_CHARS = 22_000;
// Backstop: a session spanning a huge number of days would fan out into that
// many LLM calls. Cap and report what was dropped (oldest days first).
const MAX_DAYS = 21;

interface MsgRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

// One-shot, tool-less text generation (mirrors timeline/distill.ts).
async function run(system: string, prompt: string): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      model: MODEL,
      // Headroom: a single text distill is normally 1 turn, but a stray
      // thinking/format step shouldn't trip "max turns (1)" → 500.
      maxTurns: 6,
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
  return out.trim();
}

function langLine(locale: UiLocale): string {
  return locale === 'ko'
    ? 'Write the document in Korean (한국어).'
    : 'Write the document in English.';
}

function daySystem(locale: UiLocale): string {
  return [
    'You are documenting a developer\'s work so a SUCCESSOR can take over without them.',
    'Preserve the REASONING and tacit knowledge — not just WHAT was done but WHY:',
    'decisions and their rationale, alternatives considered and rejected, dead-ends,',
    'things that were tricky or non-obvious, gotchas, and assumptions made.',
    'Be detailed and faithful. Do NOT over-summarize — losing the "why" defeats the',
    'purpose. Reference concrete files, commands, identifiers, and errors when they',
    'appear. Output GitHub-flavored markdown (no top-level H1; start at "###").',
    'You have NO tools — do not try to read files or run commands; work ONLY from',
    'the transcript text given. Respond with the markdown directly.',
    langLine(locale),
  ].join(' ');
}

function summarySystem(locale: UiLocale): string {
  return [
    'You are writing the HANDOVER SUMMARY a successor reads first, synthesized from',
    'the per-day notes that follow the prompt. Produce these sections (markdown,',
    'start at "##"): "현재 상태 / Current state", "핵심 결정 / Key decisions (+why)",',
    '"남은 일 · 다음 스텝 / Open items & next steps", "함정 · 주의 / Gotchas",',
    '"핵심 파일 · 명령 / Key files & commands". Be specific and actionable; prefer',
    'concrete references over generalities. Omit a section only if truly empty.',
    'You have NO tools — synthesize ONLY from the notes given. Respond with the',
    'markdown directly.',
    langLine(locale),
  ].join(' ');
}

function renderTranscript(msgs: MsgRow[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const m of msgs) {
    if (used >= budget) {
      parts.push('… (truncated)');
      break;
    }
    const who = m.role === 'user' ? 'User' : 'Assistant';
    const block = `**${who}:** ${m.content}`;
    parts.push(block.slice(0, Math.max(budget - used, 0)));
    used += block.length;
  }
  return parts.join('\n\n');
}

// Split a day's messages into windows each <= budget chars, so a long day is
// distilled in several small requests instead of one oversized prompt. A single
// message bigger than the budget gets its own (truncated) window.
function chunkMessages(msgs: MsgRow[], budget: number): MsgRow[][] {
  const chunks: MsgRow[][] = [];
  let cur: MsgRow[] = [];
  let used = 0;
  for (const m of msgs) {
    const len = (m.content?.length ?? 0) + 16;
    if (used + len > budget && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(m);
    used += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export interface HandoverResult {
  markdown: string;
  days: number;
  truncatedDays: number;
}

/** The saved timeline for a session, or null if never generated. */
export function getSavedTimeline(
  sessionId: string,
): { markdown: string; generatedAt: string } | null {
  const row = getDb()
    .prepare('SELECT markdown, generated_at FROM session_timelines WHERE session_id = ?')
    .get(sessionId) as { markdown: string; generated_at: string } | undefined;
  return row ? { markdown: row.markdown, generatedAt: row.generated_at } : null;
}

/** Persist (upsert) a session's generated timeline. Returns the timestamp. */
export function saveTimeline(sessionId: string, markdown: string): string {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO session_timelines (session_id, markdown, generated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET markdown = excluded.markdown, generated_at = excluded.generated_at`,
    )
    .run(sessionId, markdown, now);
  return now;
}

/** Generate a handover document for one session. */
export async function generateSessionHandover(
  sessionId: string,
  opts: { runText?: (system: string, prompt: string) => Promise<string> } = {},
): Promise<HandoverResult> {
  const runText = opts.runText ?? run;
  const db = getDb();
  const session = db
    .prepare('SELECT id, title FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string; title: string | null } | undefined;
  if (!session) throw new Error('session not found');

  const msgs = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE session_id = ? AND role IN ('user','assistant')
         AND content <> '' AND source_message_id IS NULL
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as MsgRow[];

  const title = session.title?.trim() || `Session ${sessionId}`;
  if (msgs.length === 0) {
    return { markdown: `# Handover — ${title}\n\n_(no conversation to hand over yet)_\n`, days: 0, truncatedDays: 0 };
  }

  // Group by local day, chronological.
  const byDay = new Map<string, MsgRow[]>();
  for (const m of msgs) {
    const d = localDateOf(m.created_at);
    const arr = byDay.get(d) ?? [];
    arr.push(m);
    byDay.set(d, arr);
  }
  let dates = [...byDay.keys()].sort();
  let truncatedDays = 0;
  if (dates.length > MAX_DAYS) {
    truncatedDays = dates.length - MAX_DAYS;
    dates = dates.slice(-MAX_DAYS); // keep the most recent days
  }

  const locale = getUiConfig().locale;

  // Per-day detailed distill — each day split into small windows so no single
  // request is oversized (the cause of the maxTurns/500 failure). Sequential:
  // independent claude calls, kept small + reliable.
  const sys = daySystem(locale);
  const dayOutputs: { date: string; md: string }[] = [];
  for (const date of dates) {
    const chunks = chunkMessages(byDay.get(date)!, CHUNK_CHARS);
    const partNotes: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const transcript = renderTranscript(chunks[i], CHUNK_CHARS);
      const part = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
      const md = await runText(
        sys,
        `Date: ${date}${part}\nSession: "${title}"\n\nProduce a detailed account of what was done in this slice and the thinking behind it.\n\n--- TRANSCRIPT ---\n${transcript}`,
      );
      if (md) partNotes.push(md);
    }
    if (partNotes.length > 0) dayOutputs.push({ date, md: partNotes.join('\n\n') });
  }

  // Summary synthesized from the day notes. Cap the input so a long session's
  // concatenated notes don't oversize this one call either (keep the most
  // recent days, where the current state lives).
  let notesBlock = '';
  for (let i = dayOutputs.length - 1; i >= 0; i--) {
    const d = dayOutputs[i];
    const block = `## ${d.date}\n${d.md}\n\n`;
    if (notesBlock.length + block.length > CHUNK_CHARS * 2) break;
    notesBlock = block + notesBlock; // prepend → keep chronological, drop oldest
  }
  const summary = await runText(
    summarySystem(locale),
    `Session: "${title}"\n\n--- PER-DAY NOTES ---\n${notesBlock}`,
  );

  const parts: string[] = [`# Handover — ${title}`, ''];
  if (truncatedDays > 0) {
    parts.push(`> _${truncatedDays} older day(s) omitted (cap ${MAX_DAYS})._`, '');
  }
  if (summary) parts.push(summary, '');
  parts.push('---', '', '# Day-by-day');
  for (const d of dayOutputs) {
    parts.push('', `## ${d.date}`, '', d.md);
  }
  return { markdown: parts.join('\n') + '\n', days: dayOutputs.length, truncatedDays };
}
