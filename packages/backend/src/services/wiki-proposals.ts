// Wiki proposal store (docs/knowledge-system-v2.md, Phase 2a). The durable
// staging layer between a proposer (gardener / auto-analyzer) and the user (who
// accepts/rejects). Section/archive edits route through the deterministic
// curation primitives (spliceAutoSection / archivePage, #125); `replace_page`
// (auto-analyzer) writes the whole conventions page — the human reviews the FULL
// before/after diff before accepting, which is the gate against clobbering any
// hand edits. All applies run on the shared wiki write chain and are blocked if
// the target page changed since the proposal was computed.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  WikiProposal,
  WikiProposalDiff,
  WikiProposalKind,
} from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { getWikiRoot } from './wiki-reader.js';
import { runOnWikiChain } from './wiki-sync.js';
import { rebuildWikiIndexInner } from './wiki-index-builder.js';
import {
  archivePage,
  assertSafeRelPath,
  spliceAutoSection,
} from './wiki-curation.js';

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

interface ProposalRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  rel_path: string;
  payload: string;
  base_hash: string | null;
  created_at: string;
  updated_at: string;
}

function toProposal(row: ProposalRow): WikiProposal {
  return {
    id: row.id,
    kind: row.kind as WikiProposalKind,
    status: row.status as WikiProposal['status'],
    title: row.title,
    relPath: row.rel_path,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pageFile(root: string, relPath: string): string {
  return path.join(root, 'pages', relPath);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readPageOrNull(
  root: string,
  relPath: string,
): Promise<string | null> {
  const file = pageFile(root, relPath);
  if (!existsSync(file)) return null;
  return readFile(file, 'utf8');
}

function getRow(id: string): ProposalRow | undefined {
  return getDb()
    .prepare('SELECT * FROM wiki_proposals WHERE id = ?')
    .get(id) as ProposalRow | undefined;
}

export interface CreateProposalInput {
  kind: WikiProposalKind;
  title: string;
  relPath: string;
  payload: Record<string, unknown>;
}

/** Stage a proposal. Pins the target page's current hash for staleness checks. */
export async function createProposal(
  input: CreateProposalInput,
  opts: { root?: string; now?: string } = {},
): Promise<WikiProposal> {
  // Guard the target path on the way in — an LLM authors these (Phase 2b), and
  // the edit_section apply writes straight to pages/<relPath>.
  assertSafeRelPath(input.relPath);
  if (input.kind === 'edit_section') {
    const content = input.payload.newSectionContent;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ProposalError(
        'edit_section requires a non-empty string payload.newSectionContent',
      );
    }
  }
  if (input.kind === 'replace_page') {
    const md = input.payload.markdown;
    if (typeof md !== 'string' || md.trim() === '') {
      throw new ProposalError('replace_page requires a non-empty string payload.markdown');
    }
  }
  const root = opts.root ?? getWikiRoot();
  const now = opts.now ?? new Date().toISOString();
  const current = await readPageOrNull(root, input.relPath);
  const baseHash = current === null ? null : sha256(current);
  const id = nanoid();
  getDb()
    .prepare(
      `INSERT INTO wiki_proposals
         (id, kind, status, title, rel_path, payload, base_hash, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.title,
      input.relPath,
      JSON.stringify(input.payload),
      baseHash,
      now,
      now,
    );
  return toProposal(getRow(id)!);
}

export function listProposals(status?: WikiProposal['status']): WikiProposal[] {
  const db = getDb();
  const rows = (
    status
      ? db
          .prepare(
            'SELECT * FROM wiki_proposals WHERE status = ? ORDER BY created_at DESC',
          )
          .all(status)
      : db
          .prepare('SELECT * FROM wiki_proposals ORDER BY created_at DESC')
          .all()
  ) as ProposalRow[];
  return rows.map(toProposal);
}

// Compute the page text a proposal would produce (null = page removed). Throws
// CurationError/ProposalError on an invalid target.
function computeAfter(
  kind: WikiProposalKind,
  before: string | null,
  payload: Record<string, unknown>,
): string | null {
  if (kind === 'edit_section') {
    if (before === null) throw new ProposalError('target page not found', 404);
    return spliceAutoSection(before, String(payload.newSectionContent ?? ''));
  }
  if (kind === 'replace_page') {
    // Full-page replacement (or creation when `before` is null). Used by the
    // auto-analyzer to stage a regenerated conventions page for review.
    return String(payload.markdown ?? '');
  }
  if (kind === 'archive_page') return null; // the page moves to the archive
  throw new ProposalError(`unknown proposal kind: ${kind}`, 400);
}

function isStale(baseHash: string | null, before: string | null): boolean {
  // Page didn't exist at proposal time: a page appearing since is an
  // unexpected target the proposal never saw → treat as stale.
  if (baseHash === null) return before !== null;
  // Existed at proposal time: stale if it has since changed or gone.
  return before === null || sha256(before) !== baseHash;
}

/** A proposal + the before/after the review UI renders, with a staleness flag. */
export async function getProposalDiff(
  id: string,
  root?: string,
): Promise<WikiProposalDiff> {
  const row = getRow(id);
  if (!row) throw new ProposalError('proposal not found', 404);
  const proposal = toProposal(row);
  const r = root ?? getWikiRoot();
  const before = await readPageOrNull(r, proposal.relPath);
  let after: string | null = null;
  let error: string | null = null;
  try {
    after = computeAfter(proposal.kind, before, proposal.payload);
  } catch (e) {
    // Distinguish "can't apply" from a legitimate archive (after=null, error=null).
    after = null;
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    proposal,
    before,
    after,
    error,
    stale: proposal.status === 'pending' && isStale(row.base_hash, before),
  };
}

// Advance a session's synced cursor to `newId` IFF that is not chronologically
// behind the session's current cursor. Used by the sandboxed-sync accept path:
// accepting a staged page change is what "consumes" the session's messages, so
// the cursor only moves on accept (not when the sandbox runs). Safe against:
//   - a deleted session row (no-op),
//   - either message id no longer existing (skip — can't compare safely),
//   - a backwards move (NEVER move the cursor back).
function advanceSyncedCursor(
  sessionId: string,
  newId: string,
  now: string,
): void {
  const db = getDb();
  const session = db
    .prepare('SELECT last_synced_message_id FROM sessions WHERE id = ?')
    .get(sessionId) as { last_synced_message_id: string | null } | undefined;
  if (!session) return; // session gone — nothing to advance

  const newRow = db
    .prepare('SELECT created_at FROM messages WHERE id = ?')
    .get(newId) as { created_at: string } | undefined;
  if (!newRow) return; // target message no longer exists — skip safely

  const currentId = session.last_synced_message_id;
  if (currentId) {
    const curRow = db
      .prepare('SELECT created_at FROM messages WHERE id = ?')
      .get(currentId) as { created_at: string } | undefined;
    // If the current cursor message is gone we can't compare — advancing could
    // move backwards, so skip to stay safe.
    if (!curRow) return;
    // Never move the cursor backwards (or sideways onto an older message).
    if (newRow.created_at < curRow.created_at) return;
  }

  db.prepare(
    'UPDATE sessions SET last_synced_message_id = ?, updated_at = ? WHERE id = ?',
  ).run(newId, now, sessionId);
}

/** Apply a pending proposal via the curation primitives, on the wiki chain. */
export function acceptProposal(
  id: string,
  opts: { root?: string; now?: string } = {},
): Promise<WikiProposal> {
  return runOnWikiChain(async () => {
    const root = opts.root ?? getWikiRoot();
    const now = opts.now ?? new Date().toISOString();
    const row = getRow(id);
    if (!row) throw new ProposalError('proposal not found', 404);
    if (row.status !== 'pending') {
      throw new ProposalError(`proposal already ${row.status}`, 409);
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const before = await readPageOrNull(root, row.rel_path);
    if (isStale(row.base_hash, before)) {
      throw new ProposalError(
        'the target page changed since this proposal — regenerate it',
        409,
      );
    }
    if (row.kind === 'edit_section') {
      if (before === null) throw new ProposalError('target page not found', 404);
      assertSafeRelPath(row.rel_path); // defense in depth before the write
      const next = spliceAutoSection(
        before,
        String(payload.newSectionContent ?? ''),
      );
      await writeFile(pageFile(root, row.rel_path), next, 'utf8');
    } else if (row.kind === 'replace_page') {
      assertSafeRelPath(row.rel_path);
      // Full-page write — creates the file if it didn't exist (auto-analyzer).
      await mkdir(path.dirname(pageFile(root, row.rel_path)), { recursive: true });
      await writeFile(pageFile(root, row.rel_path), String(payload.markdown ?? ''), 'utf8');
    } else if (row.kind === 'archive_page') {
      await archivePage(
        row.rel_path,
        {
          reason: String(payload.reason ?? 'gardener proposal'),
          proposalId: row.id,
          supersededBy:
            typeof payload.supersededBy === 'string'
              ? payload.supersededBy
              : null,
        },
        { root, now },
      );
    } else {
      throw new ProposalError(`unknown proposal kind: ${row.kind}`, 400);
    }

    // Accept bookkeeping (wrapped so a failure here never fails the page write;
    // we're already inside runOnWikiChain, so call the NON-chain-wrapping
    // rebuildWikiIndexInner to avoid a self-deadlock):
    //  - sandboxed-sync proposals carry the originating session + the message id
    //    distilled through → advance that session's synced cursor.
    //  - ALWAYS rebuild the deterministic index after a page-changing accept
    //    (sync, conventions auto-wiki, or a gardener merge) so index.md never
    //    drifts — conventions pages used to be missing from it entirely.
    try {
      const sessionId = payload.sessionId;
      const syncedThroughMessageId = payload.syncedThroughMessageId;
      if (
        typeof sessionId === 'string' &&
        sessionId &&
        typeof syncedThroughMessageId === 'string' &&
        syncedThroughMessageId
      ) {
        advanceSyncedCursor(sessionId, syncedThroughMessageId, now);
      }
      await rebuildWikiIndexInner(root);
    } catch {
      // Never fail the apply over a cursor/index bookkeeping error.
    }

    getDb()
      .prepare(
        "UPDATE wiki_proposals SET status = 'applied', updated_at = ? WHERE id = ?",
      )
      .run(now, id);
    return toProposal(getRow(id)!);
  });
}

// On the same chain as acceptProposal so a reject can't interleave with an
// in-flight accept's read→write→status window (which would otherwise let an
// applied page end up marked rejected, or vice-versa).
export function rejectProposal(id: string, now?: string): Promise<WikiProposal> {
  return runOnWikiChain(async () => {
    const row = getRow(id);
    if (!row) throw new ProposalError('proposal not found', 404);
    if (row.status !== 'pending') {
      throw new ProposalError(`proposal already ${row.status}`, 409);
    }
    getDb()
      .prepare(
        "UPDATE wiki_proposals SET status = 'rejected', updated_at = ? WHERE id = ?",
      )
      .run(now ?? new Date().toISOString(), id);
    return toProposal(getRow(id)!);
  });
}
