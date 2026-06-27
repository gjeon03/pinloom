import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rebuildWikiIndex, _internal } from './wiki-index-builder.js';

const OPEN = '<!-- pinloom:auto-section -->';
const CLOSE = '<!-- /pinloom:auto-section -->';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pinloom-index-'));
  await mkdir(path.join(root, 'pages'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fm(args: {
  appliesTo?: string[];
  topic?: string[];
  summary?: string;
  title?: string;
}): string {
  const lines = ['---'];
  lines.push(`applies_to: [${(args.appliesTo ?? ['global']).join(', ')}]`);
  lines.push(`topic: [${(args.topic ?? []).join(', ')}]`);
  lines.push('related: []');
  lines.push(`summary: ${JSON.stringify(args.summary ?? '')}`);
  lines.push('---', '');
  lines.push(`# ${args.title ?? 'Page'}`, '');
  return lines.join('\n');
}

async function seed(rel: string, body: string): Promise<void> {
  const full = path.join(root, 'pages', rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

function readIndex(): Promise<string> {
  return readFile(path.join(root, 'index.md'), 'utf8');
}

function autoSection(index: string): string {
  const a = index.indexOf(OPEN) + OPEN.length;
  const b = index.indexOf(CLOSE);
  return index.slice(a, b);
}

describe('rebuildWikiIndex', () => {
  it('groups pages by primary topic and formats lines exactly', async () => {
    await seed(
      'react-hooks.md',
      fm({ appliesTo: ['myrepo'], topic: ['react', 'hooks'], summary: 'hook tips' }),
    );
    await seed(
      'git-flow.md',
      fm({ appliesTo: ['global'], topic: ['git'], summary: 'branch rules' }),
    );

    await rebuildWikiIndex(root);
    const section = autoSection(await readIndex());

    expect(section).toContain('## React');
    expect(section).toContain('## Git');
    expect(section).toContain(
      '- [react-hooks.md](./pages/react-hooks.md) `[myrepo]` `react, hooks` — hook tips',
    );
    expect(section).toContain(
      '- [git-flow.md](./pages/git-flow.md) `[global]` `git` — branch rules',
    );
  });

  it('byte-preserves the header above the open marker', async () => {
    const header = '# My custom wiki\n\nHand-written prose the agent must never touch.\n\n';
    await writeFile(
      path.join(root, 'index.md'),
      `${header}${OPEN}\n\n_(old)_\n\n${CLOSE}\n`,
      'utf8',
    );
    await seed('p.md', fm({ topic: ['t'], summary: 's' }));

    await rebuildWikiIndex(root);
    const index = await readIndex();
    expect(index.slice(0, index.indexOf(OPEN))).toBe(header);
  });

  it('preserves user prose below the close marker byte-for-byte', async () => {
    const tail = '\n\nFooter prose owned by the user.\n';
    await writeFile(
      path.join(root, 'index.md'),
      `# H\n\n${OPEN}\n\n_(old)_\n\n${CLOSE}${tail}`,
      'utf8',
    );
    await seed('p.md', fm({ topic: ['t'], summary: 's' }));

    await rebuildWikiIndex(root);
    const index = await readIndex();
    expect(index.slice(index.indexOf(CLOSE))).toBe(`${CLOSE}${tail}`);
  });

  it('renders a page with no topic under Uncategorized, no dangling backticks/dash', async () => {
    await seed('lonely.md', fm({ appliesTo: ['global'], topic: [], summary: '' }));

    await rebuildWikiIndex(root);
    const section = autoSection(await readIndex());

    expect(section).toContain('## Uncategorized');
    // No topic backtick group, no ` — ` summary tail.
    expect(section).toContain('- [lonely.md](./pages/lonely.md) `[global]`');
    expect(section).not.toMatch(/lonely\.md\)[^\n]*``/); // no empty backtick pair
    expect(section).not.toMatch(/lonely\.md\)[^\n]* — /); // no dangling dash
  });

  it('places Uncategorized last and preserves existing group order', async () => {
    // Existing index has Git before React.
    await writeFile(
      path.join(root, 'index.md'),
      `# H\n\n${OPEN}\n\n## Git\n\n## React\n\n${CLOSE}\n`,
      'utf8',
    );
    await seed('r.md', fm({ topic: ['react'], summary: 'r' }));
    await seed('g.md', fm({ topic: ['git'], summary: 'g' }));
    await seed('n.md', fm({ topic: [], summary: 'n' }));

    await rebuildWikiIndex(root);
    const section = autoSection(await readIndex());
    const gitAt = section.indexOf('## Git');
    const reactAt = section.indexOf('## React');
    const uncatAt = section.indexOf('## Uncategorized');
    expect(gitAt).toBeGreaterThan(-1);
    expect(gitAt).toBeLessThan(reactAt); // prior order kept
    expect(uncatAt).toBeGreaterThan(reactAt); // catch-all last
  });

  it('creates a fresh index when none exists', async () => {
    await seed('p.md', fm({ topic: ['t'], summary: 's' }));
    await rebuildWikiIndex(root);
    const index = await readIndex();
    expect(index).toContain(OPEN);
    expect(index).toContain(CLOSE);
    expect(index).toContain('- [p.md](./pages/p.md)');
  });

  it('reads promoted <dir>/index.md pages', async () => {
    await seed('big/index.md', fm({ topic: ['arch'], summary: 'big topic' }));
    await rebuildWikiIndex(root);
    const section = autoSection(await readIndex());
    expect(section).toContain('- [big](./pages/big/index.md) `[global]` `arch` — big topic');
  });
});

describe('renderLine (pure)', () => {
  it('omits topics and summary cleanly when both empty', () => {
    const line = _internal.renderLine({
      relPath: 'x.md',
      linkText: 'x.md',
      appliesTo: [],
      topics: [],
      summary: '   ',
    });
    expect(line).toBe('- [x.md](./pages/x.md) `[global]`');
  });
});
