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
