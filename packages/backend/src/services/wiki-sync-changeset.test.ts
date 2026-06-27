import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { computeChangeset, sandboxWriteGuard } from './wiki-sync.js';

const TMP = '/tmp/pinloom-sync-abc';

describe('sandboxWriteGuard (containment)', () => {
  it('allows a relative write under the sandbox', () => {
    expect(sandboxWriteGuard(TMP, 'Write', { file_path: 'pages/x.md' }).behavior).toBe('allow');
  });
  it('allows an absolute write INSIDE the sandbox', () => {
    expect(
      sandboxWriteGuard(TMP, 'Write', { file_path: path.join(TMP, 'pages/x.md') }).behavior,
    ).toBe('allow');
  });
  it('DENIES an absolute write to the real wiki (sandbox escape)', () => {
    const r = sandboxWriteGuard(TMP, 'Write', {
      file_path: '/Users/me/.pinloom/wiki/pages/x.md',
    });
    expect(r.behavior).toBe('deny');
  });
  it('DENIES a path-traversal escape', () => {
    expect(sandboxWriteGuard(TMP, 'Edit', { file_path: '../../etc/passwd' }).behavior).toBe('deny');
  });
  it('allows read-only tools regardless of path', () => {
    expect(sandboxWriteGuard(TMP, 'Read', { file_path: '/anywhere' }).behavior).toBe('allow');
    expect(sandboxWriteGuard(TMP, 'Glob', { pattern: '**' }).behavior).toBe('allow');
  });
  it('guards Edit + NotebookEdit too', () => {
    expect(sandboxWriteGuard(TMP, 'Edit', { file_path: '/outside.md' }).behavior).toBe('deny');
    expect(
      sandboxWriteGuard(TMP, 'NotebookEdit', { notebook_path: '/outside.ipynb' }).behavior,
    ).toBe('deny');
  });
});

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('computeChangeset', () => {
  it('detects a changed page as a replace', () => {
    const cs = computeChangeset(m({ 'a.md': 'old' }), m({ 'a.md': 'new' }));
    expect(cs).toEqual([{ relPath: 'a.md', before: 'old', after: 'new', op: 'replace' }]);
  });

  it('detects a brand-new page as a replace (creation, before=null)', () => {
    const cs = computeChangeset(m({}), m({ 'new.md': 'hi' }));
    expect(cs).toEqual([{ relPath: 'new.md', before: null, after: 'hi', op: 'replace' }]);
  });

  it('detects a removed page as an archive', () => {
    const cs = computeChangeset(m({ 'gone.md': 'bye' }), m({}));
    expect(cs).toEqual([{ relPath: 'gone.md', before: 'bye', after: null, op: 'archive' }]);
  });

  it('drops no-op (byte-identical) pages', () => {
    expect(computeChangeset(m({ 'a.md': 'same' }), m({ 'a.md': 'same' }))).toEqual([]);
  });

  it('never touches conventions-*.md (owned by the conventions auto-wiki)', () => {
    const cs = computeChangeset(
      m({ 'conventions-foo.md': 'x' }),
      m({ 'conventions-foo.md': 'y', 'topic.md': 'z' }),
    );
    expect(cs.map((c) => c.relPath)).toEqual(['topic.md']);
  });

  it('never surfaces index.md / _schema.md even if they changed', () => {
    const cs = computeChangeset(
      m({ 'index.md': 'a', '_schema.md': 'b' }),
      m({ 'index.md': 'a2', '_schema.md': 'b2' }),
    );
    expect(cs).toEqual([]);
  });

  it('returns a stable, relPath-sorted changeset for mixed ops', () => {
    const cs = computeChangeset(
      m({ 'b.md': 'old', 'z-del.md': 'bye' }),
      m({ 'b.md': 'new', 'a-new.md': 'hi' }),
    );
    expect(cs.map((c) => `${c.op}:${c.relPath}`)).toEqual([
      'replace:a-new.md',
      'replace:b.md',
      'archive:z-del.md',
    ]);
  });
});
