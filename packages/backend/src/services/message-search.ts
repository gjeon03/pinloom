// Full-text search over conversation history (docs/knowledge-system-v2.md,
// Phase 1). Backed by the external-content trigram FTS5 table `messages_fts`
// created in migration 29.
//
// Query strategy (the trigram tokenizer only matches at >= 3 chars):
//  - tokens of >= 3 codepoints  → FTS5 MATCH, each as a double-quoted phrase
//    (ANDed). Quoting is mandatory: it neutralises FTS5 operators so a raw
//    user string can never become a MATCH syntax error (500) or injection.
//  - tokens of 1-2 codepoints (common 2-syllable Korean: 배포, 인증, 타입) →
//    a LIKE on the BASE messages table with the same role filter the index
//    uses. (A LIKE on the external-content FTS column would read every row,
//    including the tool/empty rows we deliberately don't index, and isn't
//    trigram-accelerated anyway — verified.) A full scan is fine at local,
//    single-user scale.
//
// When at least one >= 3-char token exists we drive from `messages_fts` (so
// only indexed user/assistant rows are considered and we can rank by bm25);
// with only short tokens we drive from `messages` directly.

import type { Database } from 'better-sqlite3';
import type { MessageRole, MessageSearchResult } from '@pinloom/shared';
import { isVectorAvailable } from '../db/connection.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { MESSAGE_VECTORS, knn } from './vector-store.js';

const TRIGRAM_MIN = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXCERPT_WINDOW = 160;
const EXCERPT_LEAD = 48;

// The wire shape lives in @pinloom/shared (MessageSearchResult) so the route
// and the frontend agree on one contract.

interface Row {
  id: string;
  session_id: string;
  session_title: string | null;
  project_id: string;
  project_name: string;
  role: string;
  content: string;
  created_at: string;
}

export interface TokenizedQuery {
  matchTokens: string[];
  likeTokens: string[];
}

/** Split a raw query into FTS-MATCH tokens (>=3 chars) and LIKE tokens (1-2 chars). */
export function tokenizeQuery(raw: string): TokenizedQuery {
  const matchTokens: string[] = [];
  const likeTokens: string[] = [];
  for (const tok of raw.trim().split(/\s+/)) {
    if (!tok) continue;
    if ([...tok].length >= TRIGRAM_MIN) matchTokens.push(tok);
    else likeTokens.push(tok);
  }
  return { matchTokens, likeTokens };
}

/** Build a safe FTS5 MATCH expression: each token a double-quoted phrase, ANDed. */
export function toMatchExpr(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Build a LIKE parameter, escaping the LIKE wildcards under `ESCAPE '\'`. */
export function toLikeParam(token: string): string {
  return `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  return out;
}

// A content window around the first matched token, with highlight offsets.
// Highlighting is best-effort: the trigram index matches with `remove_diacritics`,
// so a row can legitimately match on a normalized form whose literal substring
// isn't found by indexOf here — in that case the excerpt still renders, just
// without highlights.
export function buildExcerpt(
  content: string,
  tokens: string[],
): { excerpt: string; highlights: [number, number][] } {
  const lc = content.toLowerCase();
  let first = -1;
  for (const t of tokens) {
    const i = lc.indexOf(t.toLowerCase());
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const start = first < 0 ? 0 : Math.max(0, first - EXCERPT_LEAD);
  const end = Math.min(content.length, start + EXCERPT_WINDOW);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  const slice = content.slice(start, end);
  const excerpt = prefix + slice + suffix;

  const sliceLc = slice.toLowerCase();
  const highlights: [number, number][] = [];
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (!tl) continue;
    let idx = 0;
    while ((idx = sliceLc.indexOf(tl, idx)) >= 0) {
      highlights.push([idx + prefix.length, idx + prefix.length + t.length]);
      idx += tl.length;
    }
  }
  return { excerpt, highlights: mergeRanges(highlights) };
}

export interface SearchOptions {
  projectId?: string;
  /** Scope to a SET of projects (e.g. a project group). Supersedes projectId. */
  projectIds?: string[];
  limit?: number;
}

/** SQL fragment + pushed params scoping to a project / project set, or null. */
function projectScope(opts: SearchOptions, params: unknown[], col = 's.project_id'): string | null {
  if (opts.projectIds && opts.projectIds.length > 0) {
    params.push(...opts.projectIds);
    return `${col} IN (${opts.projectIds.map(() => '?').join(',')})`;
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    return `${col} = ?`;
  }
  return null;
}

/** Search conversation history. Returns [] for an empty/whitespace query. */
export function searchMessages(
  db: Database,
  rawQuery: string,
  opts: SearchOptions = {},
): MessageSearchResult[] {
  const { matchTokens, likeTokens } = tokenizeQuery(rawQuery);
  if (matchTokens.length === 0 && likeTokens.length === 0) return [];

  const limit = clampLimit(opts.limit);
  const where: string[] = [];
  const params: unknown[] = [];
  let from: string;
  let orderBy: string;

  if (matchTokens.length > 0) {
    from = `messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN sessions s ON s.id = m.session_id
      JOIN projects p ON p.id = s.project_id`;
    where.push('f.messages_fts MATCH ?');
    params.push(toMatchExpr(matchTokens));
    // bm25 over the MATCH tokens. Any 1-2-char LIKE tokens in a mixed query are
    // plain filters and don't influence relevance ordering (acceptable for v1).
    orderBy = 'rank';
  } else {
    from = `messages m
      JOIN sessions s ON s.id = m.session_id
      JOIN projects p ON p.id = s.project_id`;
    where.push("m.role IN ('user', 'assistant')");
    where.push("m.content <> ''");
    orderBy = 'm.created_at DESC';
  }

  for (const tok of likeTokens) {
    where.push("m.content LIKE ? ESCAPE '\\'");
    params.push(toLikeParam(tok));
  }
  const scope = projectScope(opts, params);
  if (scope) where.push(scope);

  const sql = `
    SELECT m.id, m.session_id, m.role, m.content, m.created_at,
           s.title AS session_title, s.project_id, p.name AS project_name
    FROM ${from}
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Row[];
  const tokens = [...matchTokens, ...likeTokens];
  return rows.map((r) => toResult(r, tokens));
}

function toResult(r: Row, tokens: string[]): MessageSearchResult {
  const { excerpt, highlights } = buildExcerpt(r.content, tokens);
  return {
    messageId: r.id,
    sessionId: r.session_id,
    sessionTitle: r.session_title,
    projectId: r.project_id,
    projectName: r.project_name,
    // Safe cast: tool/system rows can't reach here — the MATCH path only sees
    // messages_fts (user/assistant rows), the LIKE path filters role, and the
    // vector path only indexes user/assistant content rows.
    role: r.role as MessageRole,
    createdAt: r.created_at,
    excerpt,
    highlights,
  };
}

// Fetch + hydrate specific message ids (preserving the given order), applying
// the same role / project / non-mirror filters search uses. Used to hydrate the
// fused (vector ∪ FTS) id list.
function hydrateByIds(
  db: Database,
  ids: string[],
  tokens: string[],
  opts: SearchOptions,
): MessageSearchResult[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const params: unknown[] = [...ids];
  let where = `m.id IN (${placeholders}) AND m.role IN ('user','assistant') AND m.source_message_id IS NULL`;
  const scope = projectScope(opts, params);
  if (scope) where += ` AND ${scope}`;
  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
              s.title AS session_title, s.project_id, p.name AS project_name
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE ${where}`,
    )
    .all(...params) as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the fused ranking order; drop ids whose row was filtered out.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is Row => r !== undefined)
    .map((r) => toResult(r, tokens));
}

// Reciprocal Rank Fusion: merge several ranked id lists into one. A doc's score
// is Σ 1/(k + rank) across the lists it appears in (rank is 0-based here). k=60
// is the standard constant. Deduped by id.
const RRF_K = 60;
export function rrfFuse(lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Hybrid search: lexical FTS fused with semantic vector KNN (docs/knowledge-
 * system-v3.md §11 Step C). Falls back to EXACTLY the FTS-only `searchMessages`
 * path when no embedding provider is ready or the vector extension is absent —
 * so this never regresses the keyword case. `provider` is the warm embedding
 * provider (or null to force lexical).
 */
export async function searchMessagesHybrid(
  db: Database,
  rawQuery: string,
  opts: SearchOptions = {},
  provider: EmbeddingProvider | null = null,
): Promise<MessageSearchResult[]> {
  const { matchTokens, likeTokens } = tokenizeQuery(rawQuery);
  if (matchTokens.length === 0 && likeTokens.length === 0) return [];
  const limit = clampLimit(opts.limit);
  const tokens = [...matchTokens, ...likeTokens];

  // FTS arm (today's behavior). Pull a slightly larger pool to fuse against.
  const fts = searchMessages(db, rawQuery, {
    ...opts,
    limit: Math.min(Math.max(limit * 2, limit), MAX_LIMIT),
  });

  // Vector arm — only when a provider is warm and the extension loaded.
  let vecIds: string[] = [];
  if (provider && isVectorAvailable()) {
    try {
      const qvec = await provider.embedQuery(rawQuery);
      // Over-fetch so the project filter / fusion still has candidates.
      const k = Math.min(opts.projectId ? limit * 8 : limit * 4, 300);
      vecIds = knn(db, MESSAGE_VECTORS, qvec, Math.max(k, limit)).map((h) => h.docId);
    } catch {
      vecIds = [];
    }
  }

  // No vector signal → exactly the FTS-only result (degrade / non-regression).
  if (vecIds.length === 0) return fts.slice(0, limit);

  // M1: an only-short-Korean query has NO bm25 ranking (the FTS arm is a
  // recency-sorted LIKE list, not a relevance order), so don't pollute RRF with
  // it — prefer the semantic ranking; fall back to the FTS list if hydration is
  // empty (e.g. all vector hits filtered out by project scope).
  if (matchTokens.length === 0) {
    const semantic = hydrateByIds(db, vecIds, tokens, opts).slice(0, limit);
    return semantic.length > 0 ? semantic : fts.slice(0, limit);
  }

  // Both arms are relevance-ranked → RRF fuse, hydrate, THEN slice. Vector KNN
  // is global (not project-scoped), so out-of-project ids drop during hydration;
  // slicing AFTER hydration keeps the count from dipping below the FTS-only path
  // on a project-scoped query (the fused candidate pool is bounded — fts ≤
  // limit*2 plus the KNN top-k — so hydrating it all is cheap).
  const fusedIds = rrfFuse([fts.map((r) => r.messageId), vecIds]);
  return hydrateByIds(db, fusedIds, tokens, opts).slice(0, limit);
}
