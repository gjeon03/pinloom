import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import {
  ProposalError,
  acceptProposal,
  createProposal,
  getProposalDiff,
  listProposals,
  rejectProposal,
} from './wiki-proposals.js';

const OPEN = '<!-- pinloom:auto-section -->';
const CLOSE = '<!-- /pinloom:auto-section -->';
const NOW = '2026-06-22T00:00:00.000Z';

function page(section: string): string {
  return `---\napplies_to: [myrepo]\nsummary: "s"\n---\n# Title\n\n${OPEN}\n${section}\n${CLOSE}\n\nUser-owned tail.\n`;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-proposals-'));
  await mkdir(path.join(root, 'pages'), { recursive: true });
  getDb().exec('DELETE FROM wiki_proposals;');
});

// ─── helpers for the sandboxed-sync accept hook (cursor advance) ───
function seedSessionWithMessages(args: {
  sessionId: string;
  syncedTo: string | null;
  // [id, created_at] pairs, chronological
  messages: Array<[string, string]>;
}): void {
  const db = getDb();
  const now = '2026-06-22T00:00:00.000Z';
  const projectId = `proj-${args.sessionId}`;
  db.prepare(
    'INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'p', `/tmp/${projectId}`, now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, last_synced_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(args.sessionId, projectId, 'My session', args.syncedTo, now, now);
  for (const [id, createdAt] of args.messages) {
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, args.sessionId, 'user', 'hi', createdAt);
  }
}

function syncedCursor(sessionId: string): string | null {
  const row = getDb()
    .prepare('SELECT last_synced_message_id FROM sessions WHERE id = ?')
    .get(sessionId) as { last_synced_message_id: string | null } | undefined;
  return row?.last_synced_message_id ?? null;
}

function clearSeed(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(`proj-${sessionId}`);
}
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, body: string) {
  await writeFile(path.join(root, 'pages', rel), body, 'utf8');
}
function read(rel: string) {
  return readFile(path.join(root, 'pages', rel), 'utf8');
}

describe('edit_section proposals', () => {
  it('accepts and rewrites only the auto-section, byte-preserving the rest', async () => {
    await seed('p.md', page('old body'));
    const original = await read('p.md');
    const p = await createProposal(
      {
        kind: 'edit_section',
        title: 'Tighten p',
        relPath: 'p.md',
        payload: { newSectionContent: 'new tight body' },
      },
      { root, now: NOW },
    );
    expect(p.status).toBe('pending');

    const diff = await getProposalDiff(p.id, root);
    expect(diff.before).toBe(original);
    expect(diff.after).toContain('new tight body');
    expect(diff.stale).toBe(false);

    await acceptProposal(p.id, { root, now: NOW });
    const after = await read('p.md');
    expect(after).toContain('new tight body');
    expect(after).not.toContain('old body');
    // outside-marker bytes preserved
    expect(after.slice(after.indexOf(CLOSE))).toBe(
      original.slice(original.indexOf(CLOSE)),
    );
    expect(after.slice(0, after.indexOf(OPEN))).toBe(
      original.slice(0, original.indexOf(OPEN)),
    );
    expect(listProposals('applied').map((x) => x.id)).toEqual([p.id]);
  });
});

describe('replace_page proposals', () => {
  it('replaces an existing page wholesale on accept', async () => {
    await seed('conventions-myrepo.md', '---\nold\n---\n# Old page\n');
    const p = await createProposal(
      {
        kind: 'replace_page',
        title: 'Auto: refresh conventions',
        relPath: 'conventions-myrepo.md',
        payload: { markdown: '---\nnew\n---\n# Fresh page\n' },
      },
      { root, now: NOW },
    );
    const diff = await getProposalDiff(p.id, root);
    expect(diff.before).toContain('Old page');
    expect(diff.after).toContain('Fresh page');
    await acceptProposal(p.id, { root, now: NOW });
    expect(await read('conventions-myrepo.md')).toBe('---\nnew\n---\n# Fresh page\n');
  });

  it('rebuilds index.md on accept even for a non-sync proposal (C)', async () => {
    await writeFile(
      path.join(root, 'index.md'),
      '# Wiki\n\n<!-- pinloom:auto-section -->\n\n<!-- /pinloom:auto-section -->\n',
      'utf8',
    );
    const p = await createProposal(
      {
        kind: 'replace_page',
        title: 'Auto: conventions for foo',
        relPath: 'conventions-foo.md',
        // no sessionId in payload — this is the conventions auto-wiki path
        payload: {
          markdown: '---\napplies_to: [foo]\ntopic: [conventions]\nsummary: "foo rules"\n---\n# Foo\n',
        },
      },
      { root, now: NOW },
    );
    await acceptProposal(p.id, { root, now: NOW });
    const index = await readFile(path.join(root, 'index.md'), 'utf8');
    expect(index).toContain('conventions-foo.md'); // now listed in the index
    expect(index).toContain('# Wiki'); // user header above the marker preserved
  });

  it('creates the page when it did not exist (auto first-run)', async () => {
    const p = await createProposal(
      {
        kind: 'replace_page',
        title: 'Auto: new conventions',
        relPath: 'conventions-new.md',
        payload: { markdown: '# Brand new\n' },
      },
      { root, now: NOW },
    );
    expect(existsSync(path.join(root, 'pages', 'conventions-new.md'))).toBe(false);
    await acceptProposal(p.id, { root, now: NOW });
    expect(await read('conventions-new.md')).toBe('# Brand new\n');
  });

  it('rejects an empty markdown payload', async () => {
    await expect(
      createProposal(
        { kind: 'replace_page', title: 'x', relPath: 'c.md', payload: { markdown: '  ' } },
        { root, now: NOW },
      ),
    ).rejects.toBeInstanceOf(ProposalError);
  });

  it('blocks accept when the page changed since the proposal (stale)', async () => {
    await seed('p.md', page('v1'));
    const p = await createProposal(
      {
        kind: 'edit_section',
        title: 'edit',
        relPath: 'p.md',
        payload: { newSectionContent: 'agent body' },
      },
      { root, now: NOW },
    );
    // user hand-edits the page after the proposal was computed
    await seed('p.md', page('v1 — user edited'));
    expect((await getProposalDiff(p.id, root)).stale).toBe(true);
    await expect(acceptProposal(p.id, { root, now: NOW })).rejects.toMatchObject(
      { status: 409 },
    );
    // page untouched by the blocked apply
    expect(await read('p.md')).toContain('user edited');
  });
});

describe('archive_page proposals', () => {
  it('accepts and moves the page into the archive', async () => {
    await seed('dup.md', page('dupe'));
    const p = await createProposal(
      {
        kind: 'archive_page',
        title: 'Archive dup.md (merged into main.md)',
        relPath: 'dup.md',
        payload: { reason: 'merged', supersededBy: 'main.md' },
      },
      { root, now: NOW },
    );
    const diff = await getProposalDiff(p.id, root);
    expect(diff.before).not.toBeNull();
    expect(diff.after).toBeNull(); // page goes away

    await acceptProposal(p.id, { root, now: NOW });
    expect(existsSync(path.join(root, 'pages', 'dup.md'))).toBe(false);
    expect(existsSync(path.join(root, '_archive'))).toBe(true);
  });
});

describe('lifecycle', () => {
  it('rejects a proposal and refuses to accept a non-pending one', async () => {
    await seed('p.md', page('x'));
    const p = await createProposal(
      { kind: 'edit_section', title: 't', relPath: 'p.md', payload: { newSectionContent: 'y' } },
      { root, now: NOW },
    );
    const rejected = await rejectProposal(p.id, NOW);
    expect(rejected.status).toBe('rejected');
    await expect(acceptProposal(p.id, { root, now: NOW })).rejects.toBeInstanceOf(
      ProposalError,
    );
  });

  it('blocks reject after accept (status machine, on the same chain)', async () => {
    await seed('p.md', page('x'));
    const p = await createProposal(
      { kind: 'edit_section', title: 't', relPath: 'p.md', payload: { newSectionContent: 'y' } },
      { root, now: NOW },
    );
    await acceptProposal(p.id, { root, now: NOW });
    await expect(rejectProposal(p.id, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it('404s an unknown proposal', async () => {
    await expect(getProposalDiff('nope', root)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects a path-traversal relPath at create time', async () => {
    await expect(
      createProposal(
        {
          kind: 'edit_section',
          title: 'evil',
          relPath: '../../escape.md',
          payload: { newSectionContent: 'x' },
        },
        { root, now: NOW },
      ),
    ).rejects.toThrow();
  });

  it('rejects an edit_section with empty/missing section content', async () => {
    await seed('p.md', page('x'));
    await expect(
      createProposal(
        { kind: 'edit_section', title: 't', relPath: 'p.md', payload: {} },
        { root, now: NOW },
      ),
    ).rejects.toBeInstanceOf(ProposalError);
  });

  it('treats a page that appeared since proposal time as stale (null base_hash)', async () => {
    // proposal created when p.md does NOT exist → base_hash null
    const p = await createProposal(
      { kind: 'archive_page', title: 'arch', relPath: 'p.md', payload: { reason: 'x' } },
      { root, now: NOW },
    );
    await seed('p.md', page('user just made this')); // appears after
    expect((await getProposalDiff(p.id, root)).stale).toBe(true);
    await expect(acceptProposal(p.id, { root, now: NOW })).rejects.toMatchObject({
      status: 409,
    });
    // the user's new page is untouched
    expect(existsSync(path.join(root, 'pages', 'p.md'))).toBe(true);
  });

  it('lists pending proposals newest-first', async () => {
    await seed('a.md', page('a'));
    await seed('b.md', page('b'));
    await createProposal(
      { kind: 'edit_section', title: 'A', relPath: 'a.md', payload: { newSectionContent: '1' } },
      { root, now: '2026-06-22T00:00:00.000Z' },
    );
    await createProposal(
      { kind: 'edit_section', title: 'B', relPath: 'b.md', payload: { newSectionContent: '2' } },
      { root, now: '2026-06-22T01:00:00.000Z' },
    );
    expect(listProposals('pending').map((x) => x.title)).toEqual(['B', 'A']);
  });
});

describe('sandboxed-sync accept hook (synced cursor advance)', () => {
  it('advances last_synced_message_id when accepting a replace_page carrying session metadata', async () => {
    const sid = 'sess-advance';
    seedSessionWithMessages({
      sessionId: sid,
      syncedTo: 'm1',
      messages: [
        ['m1', '2026-06-22T00:00:01.000Z'],
        ['m2', '2026-06-22T00:00:02.000Z'],
        ['m3', '2026-06-22T00:00:03.000Z'],
      ],
    });
    try {
      const p = await createProposal(
        {
          kind: 'replace_page',
          title: 'Sync: My session → sync-note.md',
          relPath: 'sync-note.md',
          payload: {
            markdown: '---\napplies_to: [global]\n---\n# Note\n',
            sessionId: sid,
            syncedThroughMessageId: 'm3',
          },
        },
        { root, now: NOW },
      );
      await acceptProposal(p.id, { root, now: NOW });
      expect(syncedCursor(sid)).toBe('m3');
      expect(await read('sync-note.md')).toContain('# Note');
    } finally {
      clearSeed(sid);
    }
  });

  it('never moves the cursor backwards', async () => {
    const sid = 'sess-backwards';
    seedSessionWithMessages({
      sessionId: sid,
      syncedTo: 'm3', // already synced ahead
      messages: [
        ['m1', '2026-06-22T00:00:01.000Z'],
        ['m2', '2026-06-22T00:00:02.000Z'],
        ['m3', '2026-06-22T00:00:03.000Z'],
      ],
    });
    try {
      const p = await createProposal(
        {
          kind: 'replace_page',
          title: 'Sync: My session → back.md',
          relPath: 'back.md',
          payload: {
            markdown: '# Back\n',
            sessionId: sid,
            syncedThroughMessageId: 'm1', // older than current cursor m3
          },
        },
        { root, now: NOW },
      );
      await acceptProposal(p.id, { root, now: NOW });
      expect(syncedCursor(sid)).toBe('m3'); // unchanged
    } finally {
      clearSeed(sid);
    }
  });

  it('is a safe no-op when the session row is gone', async () => {
    const p = await createProposal(
      {
        kind: 'replace_page',
        title: 'Sync: ghost → ghost.md',
        relPath: 'ghost.md',
        payload: {
          markdown: '# Ghost\n',
          sessionId: 'sess-does-not-exist',
          syncedThroughMessageId: 'mX',
        },
      },
      { root, now: NOW },
    );
    // The page write still succeeds even though the session/message don't exist.
    await acceptProposal(p.id, { root, now: NOW });
    expect(await read('ghost.md')).toContain('# Ghost');
    expect(listProposals('applied').some((x) => x.id === p.id)).toBe(true);
  });
});
