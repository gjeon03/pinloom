import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_SECTION_CLOSE,
  AUTO_SECTION_OPEN,
  CurationError,
  archivePage,
  assertOnlyAutoSectionChanged,
  listArchive,
  readAutoSection,
  restorePage,
  spliceAutoSection,
} from './wiki-curation.js';

const FM = `---
applies_to: [myrepo]
summary: "How we deploy"
---
`;
function page(inside: string, userTail = '\n\nHand-written notes (mine).\n') {
  return `${FM}# Deploy\n\n${AUTO_SECTION_OPEN}\n${inside}\n${AUTO_SECTION_CLOSE}${userTail}`;
}

describe('spliceAutoSection', () => {
  it('replaces only the inside, byte-for-byte preserving the rest', () => {
    const original = page('old auto content');
    const next = spliceAutoSection(original, 'new auto content');
    expect(readAutoSection(next)).toBe('new auto content');
    // Everything outside the markers is identical.
    expect(next.slice(0, next.indexOf(AUTO_SECTION_OPEN))).toBe(
      original.slice(0, original.indexOf(AUTO_SECTION_OPEN)),
    );
    expect(next.slice(next.indexOf(AUTO_SECTION_CLOSE))).toBe(
      original.slice(original.indexOf(AUTO_SECTION_CLOSE)),
    );
  });

  it('normalizes surrounding blank lines (but preserves inner whitespace)', () => {
    const next = spliceAutoSection(page('x'), '\n\n  indented\nline\n\n');
    // Leading/trailing blank LINES are dropped; meaningful indentation stays.
    expect(readAutoSection(next)).toBe('  indented\nline');
  });

  it('appends a fresh auto-section to a marker-less page (content stays user-owned)', () => {
    const userPage = `${FM}# Notes\n\nAll mine.\n`;
    const next = spliceAutoSection(userPage, 'agent note');
    expect(next.startsWith(userPage)).toBe(true);
    expect(next).toContain(AUTO_SECTION_OPEN);
    expect(readAutoSection(next)).toBe('agent note');
  });

  it('throws on an unterminated open marker', () => {
    expect(() => spliceAutoSection(`x ${AUTO_SECTION_OPEN} y`, 'z')).toThrow(
      CurationError,
    );
  });

  it('rejects new content that contains a marker (no break-out into user area)', () => {
    expect(() =>
      spliceAutoSection(page('old'), `x\n${AUTO_SECTION_CLOSE}\nINJECTED`),
    ).toThrow(CurationError);
    expect(() =>
      spliceAutoSection(page('old'), `${AUTO_SECTION_OPEN}\nnested`),
    ).toThrow(CurationError);
  });

  it('preserves CRLF user content byte-for-byte', () => {
    const crlf = `${FM}# T\r\n\r\n${AUTO_SECTION_OPEN}\na\n${AUTO_SECTION_CLOSE}\r\nMine.\r\n`;
    const next = spliceAutoSection(crlf, 'b');
    expect(next.slice(next.indexOf(AUTO_SECTION_CLOSE))).toBe(
      crlf.slice(crlf.indexOf(AUTO_SECTION_CLOSE)),
    );
  });
});

describe('assertOnlyAutoSectionChanged', () => {
  it('passes when only the inside differs', () => {
    expect(() =>
      assertOnlyAutoSectionChanged(page('a'), page('b')),
    ).not.toThrow();
  });

  it('throws when frontmatter / pre-marker content changes', () => {
    const tampered = page('a').replace('How we deploy', 'HACKED');
    expect(() => assertOnlyAutoSectionChanged(page('a'), tampered)).toThrow(
      /before the auto-section/,
    );
  });

  it('throws when user content after the marker changes', () => {
    const tampered = page('a', '\n\nDIFFERENT tail.\n');
    expect(() => assertOnlyAutoSectionChanged(page('a'), tampered)).toThrow(
      /after the auto-section/,
    );
  });

  it('throws when markers are missing on either side', () => {
    expect(() =>
      assertOnlyAutoSectionChanged(`${FM}no markers`, page('a')),
    ).toThrow(/must contain auto-section markers/);
  });
});

describe('archive / restore', () => {
  let root: string;
  const NOW = '2026-06-22T00:00:00.000Z';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-curation-'));
    await mkdir(path.join(root, 'pages'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(rel: string, body: string) {
    const full = path.join(root, 'pages', rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }

  it('archives a page, records the manifest, and round-trips on restore', async () => {
    await seed('deploy-myrepo.md', page('hi'));
    const entry = await archivePage(
      'deploy-myrepo.md',
      { reason: 'superseded by merge', proposalId: 'p1', supersededBy: 'deploy.md' },
      { root, now: NOW },
    );
    expect(existsSync(path.join(root, 'pages', 'deploy-myrepo.md'))).toBe(false);
    expect(existsSync(path.join(root, '_archive', entry.archivedName))).toBe(true);
    expect(entry.archivedAt).toBe(NOW);

    const listed = await listArchive(root);
    expect(listed).toHaveLength(1);
    expect(listed[0].originalRelPath).toBe('deploy-myrepo.md');

    const restored = await restorePage(entry.archivedName, root);
    expect(restored.originalRelPath).toBe('deploy-myrepo.md');
    expect(existsSync(path.join(root, 'pages', 'deploy-myrepo.md'))).toBe(true);
    expect(await listArchive(root)).toHaveLength(0);
  });

  it('de-collides archived names for same-basename pages', async () => {
    await seed('a.md', 'one');
    const e1 = await archivePage('a.md', { reason: 'x' }, { root, now: NOW });
    await seed('a.md', 'two'); // a new page reuses the path
    const e2 = await archivePage('a.md', { reason: 'y' }, { root, now: NOW });
    expect(e1.archivedName).not.toBe(e2.archivedName);
    expect((await listArchive(root)).length).toBe(2);
  });

  it('refuses to restore over an existing page', async () => {
    await seed('a.md', 'orig');
    const e = await archivePage('a.md', { reason: 'x' }, { root, now: NOW });
    await seed('a.md', 'new occupant');
    await expect(restorePage(e.archivedName, root)).rejects.toThrow(
      /already exists/,
    );
  });

  it('rejects path traversal', async () => {
    await expect(
      archivePage('../escape.md', { reason: 'x' }, { root, now: NOW }),
    ).rejects.toThrow(CurationError);
  });

  it('404s archiving a missing page and restoring an unknown name', async () => {
    await expect(
      archivePage('nope.md', { reason: 'x' }, { root, now: NOW }),
    ).rejects.toThrow(/page not found/);
    await expect(restorePage('nope', root)).rejects.toThrow(/no archived page/);
  });

  it('persists a readable manifest file', async () => {
    await seed('a.md', 'x');
    await archivePage('a.md', { reason: 'cleanup' }, { root, now: NOW });
    const manifest = JSON.parse(
      await readFile(path.join(root, '_archive', 'manifest.json'), 'utf8'),
    );
    expect(manifest[0].reason).toBe('cleanup');
    expect(manifest[0].proposalId).toBeNull();
  });

  it('keeps every entry under concurrent archives (no manifest race)', async () => {
    await seed('a.md', '1');
    await seed('b.md', '2');
    await seed('c.md', '3');
    await Promise.all([
      archivePage('a.md', { reason: 'x' }, { root, now: NOW }),
      archivePage('b.md', { reason: 'x' }, { root, now: NOW }),
      archivePage('c.md', { reason: 'x' }, { root, now: NOW }),
    ]);
    const listed = await listArchive(root);
    expect(listed.map((e) => e.originalRelPath).sort()).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
  });

  it('rejects a traversal archivedName on restore (corrupt manifest)', async () => {
    await mkdir(path.join(root, '_archive'), { recursive: true });
    await writeFile(
      path.join(root, '_archive', 'manifest.json'),
      JSON.stringify([
        {
          archivedName: '../../pages/victim.md',
          originalRelPath: 'x.md',
          reason: 'r',
          proposalId: null,
          supersededBy: null,
          archivedAt: NOW,
        },
      ]),
    );
    await expect(restorePage('../../pages/victim.md', root)).rejects.toThrow(
      CurationError,
    );
  });

  it('throws on a non-array manifest instead of masking it as empty', async () => {
    await mkdir(path.join(root, '_archive'), { recursive: true });
    await writeFile(path.join(root, '_archive', 'manifest.json'), '{}');
    await expect(listArchive(root)).rejects.toThrow(/corrupt/);
  });

  it('refuses to archive a symlink (would move the link, not the bytes)', async () => {
    const { symlink } = await import('node:fs/promises');
    await seed('real.md', 'secret');
    await symlink(
      path.join(root, 'pages', 'real.md'),
      path.join(root, 'pages', 'link.md'),
    );
    await expect(
      archivePage('link.md', { reason: 'x' }, { root, now: NOW }),
    ).rejects.toThrow(CurationError);
  });
});
