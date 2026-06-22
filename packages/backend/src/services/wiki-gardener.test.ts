import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import {
  GardenerError,
  parseProposals,
  runGardener,
  type RunAgent,
} from './wiki-gardener.js';

const OPEN = '<!-- pinloom:auto-section -->';
const CLOSE = '<!-- /pinloom:auto-section -->';
const NOW = '2026-06-22T00:00:00.000Z';

function page(body: string): string {
  return `---\napplies_to: [r]\nsummary: "s"\n---\n# T\n\n${OPEN}\n${body}\n${CLOSE}\n\nMine.\n`;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-gardener-'));
  await mkdir(path.join(root, 'pages'), { recursive: true });
  await writeFile(path.join(root, 'index.md'), '# Index\n- a.md\n', 'utf8');
  getDb().exec('DELETE FROM wiki_proposals;');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const agentReturning =
  (text: string): RunAgent =>
  async () =>
    text;

describe('parseProposals', () => {
  it('parses a bare array', () => {
    expect(parseProposals('[{"kind":"x"}]')).toEqual([{ kind: 'x' }]);
  });
  it('tolerates fences / prose around the array', () => {
    expect(
      parseProposals('Here you go:\n```json\n[{"a":1}]\n```\nDone.'),
    ).toEqual([{ a: 1 }]);
  });
  it('throws when there is no array', () => {
    expect(() => parseProposals('no json here')).toThrow(GardenerError);
    expect(() => parseProposals('[broken')).toThrow(GardenerError);
  });
  it('ignores prose brackets before the real array', () => {
    expect(
      parseProposals('use [x] and [y], then:\n[{"kind":"edit_section"}]'),
    ).toEqual([{ kind: 'edit_section' }]);
  });
  it('keeps ] inside JSON string values intact', () => {
    expect(parseProposals('[{"title":"a ] bracket"}]')).toEqual([
      { title: 'a ] bracket' },
    ]);
  });
});

describe('runGardener', () => {
  it('stages valid edit_section + archive_page proposals', async () => {
    await writeFile(path.join(root, 'pages', 'a.md'), page('old'), 'utf8');
    await writeFile(path.join(root, 'pages', 'dup.md'), page('dupe'), 'utf8');
    const runAgent = agentReturning(
      JSON.stringify([
        {
          kind: 'edit_section',
          title: 'Tighten a',
          relPath: 'a.md',
          payload: { newSectionContent: 'tighter' },
        },
        {
          kind: 'archive_page',
          title: 'Archive dup',
          relPath: 'dup.md',
          payload: { reason: 'duplicate', supersededBy: 'a.md' },
        },
      ]),
    );
    const res = await runGardener({ root, runAgent, now: NOW });
    expect(res.created.map((p) => p.kind).sort()).toEqual([
      'archive_page',
      'edit_section',
    ]);
    expect(res.skipped).toBe(0);
  });

  it('skips malformed-shape and createProposal-rejected proposals', async () => {
    await writeFile(path.join(root, 'pages', 'a.md'), page('x'), 'utf8');
    const runAgent = agentReturning(
      JSON.stringify([
        { kind: 'bogus_kind', title: 't', relPath: 'a.md', payload: {} }, // bad kind
        { kind: 'edit_section', title: '', relPath: 'a.md', payload: { newSectionContent: 'y' } }, // empty title
        { kind: 'edit_section', title: 't', relPath: '../../escape.md', payload: { newSectionContent: 'y' } }, // traversal → createProposal throws
        { kind: 'edit_section', title: 't', relPath: 'missing.md', payload: { newSectionContent: 'y' } }, // page exists check (base_hash null is allowed at create) — still staged
        { kind: 'edit_section', title: 'ok', relPath: 'a.md', payload: { newSectionContent: 'good' } }, // valid
      ]),
    );
    const res = await runGardener({ root, runAgent, now: NOW });
    // bad-kind + empty-title + traversal skipped; missing.md stages (created
    // when page absent → base_hash null, flagged stale at review time); a.md ok.
    expect(res.created.map((p) => p.relPath).sort()).toEqual([
      'a.md',
      'missing.md',
    ]);
    expect(res.skipped).toBe(3);
  });

  it('whitelists payload keys (LLM cannot smuggle extra fields)', async () => {
    await writeFile(path.join(root, 'pages', 'a.md'), page('x'), 'utf8');
    const runAgent = agentReturning(
      JSON.stringify([
        {
          kind: 'edit_section',
          title: 't',
          relPath: 'a.md',
          payload: { newSectionContent: 'good', evil: 'DROP TABLE', extra: 1 },
        },
      ]),
    );
    const res = await runGardener({ root, runAgent, now: NOW });
    expect(Object.keys(res.created[0].payload).sort()).toEqual([
      'newSectionContent',
    ]);
  });

  it('returns nothing for an empty wiki', async () => {
    await rm(path.join(root, 'index.md'));
    const res = await runGardener({
      root,
      runAgent: agentReturning('SHOULD NOT BE CALLED'),
      now: NOW,
    });
    expect(res.created).toEqual([]);
  });

  it('propagates a GardenerError when the agent returns no array', async () => {
    await writeFile(path.join(root, 'pages', 'a.md'), page('x'), 'utf8');
    await expect(
      runGardener({ root, runAgent: agentReturning('sorry, no.'), now: NOW }),
    ).rejects.toBeInstanceOf(GardenerError);
  });
});
