// Deterministic index.md rebuild. The sync agent used to maintain index.md
// itself (inside the auto-section markers); the proposal-preview flow stages
// page changes instead, so the index has to be regenerated from the pages'
// frontmatter at accept time — no LLM, byte-precise, user-prose preserved.
//
// We splice ONLY the region between the auto-section markers. Everything above
// the open marker (and below a close marker if present) is user-owned and
// preserved byte-for-byte.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, getWikiRoot } from './wiki-reader.js';
import { runOnWikiChain } from './wiki-sync.js';

const AUTO_SECTION_OPEN = '<!-- pinloom:auto-section -->';
const AUTO_SECTION_CLOSE = '<!-- /pinloom:auto-section -->';

const DEFAULT_INDEX_HEADER = `# Personal pinloom wiki

This is your personal knowledge base, written and maintained by pinloom from
your sessions. The AI reads this file (and the pages below) at the start of
new turns when prior knowledge might be relevant.

`;

interface IndexPage {
  /** Link target relative to pages/ (e.g. "foo.md" or "foo/index.md"). */
  relPath: string;
  /** File name used in the link text — the first path segment for promoted dirs. */
  linkText: string;
  appliesTo: string[];
  topics: string[];
  summary: string;
}

const UNCATEGORIZED_GROUP = 'Uncategorized';

// Title-case a topic token for use as a group heading. We keep it simple —
// hyphen/space separated words get their first letter upper-cased. Existing
// headings (parsed from the current index) take precedence so hand-tuned
// labels like "Node.js / Next.js" survive across rebuilds.
function titleCaseTopic(topic: string): string {
  return topic
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// List every page under pages/ (flat .md files + promoted <dir>/index.md).
async function listIndexPages(pagesDir: string): Promise<IndexPage[]> {
  if (!existsSync(pagesDir)) return [];
  const out: IndexPage[] = [];
  const entries = await readdir(pagesDir);
  for (const entry of entries) {
    const full = path.join(pagesDir, entry);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const inner = path.join(full, 'index.md');
      if (!existsSync(inner)) continue;
      const body = await readFile(inner, 'utf8');
      const { meta } = parseFrontmatter(body);
      out.push({
        relPath: `${entry}/index.md`,
        linkText: entry,
        appliesTo: meta.appliesTo,
        topics: meta.topic,
        summary: meta.summary,
      });
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    const body = await readFile(full, 'utf8');
    const { meta } = parseFrontmatter(body);
    out.push({
      relPath: entry,
      linkText: entry,
      appliesTo: meta.appliesTo,
      topics: meta.topic,
      summary: meta.summary,
    });
  }
  return out;
}

// Render one page line EXACTLY in the existing index format:
//   - [<file>](./pages/<file>) `[applies_to]` `topic1, topic2` — summary
// applies_to is always rendered (defaults to [global] when empty, matching the
// frontmatter convention). The topics backtick group and the ` — summary` tail
// are each omitted when empty so there are no dangling backticks or dashes.
function renderLine(page: IndexPage): string {
  const applies = page.appliesTo.length > 0 ? page.appliesTo : ['global'];
  let line = `- [${page.linkText}](./pages/${page.relPath}) \`[${applies.join(', ')}]\``;
  if (page.topics.length > 0) {
    line += ` \`${page.topics.join(', ')}\``;
  }
  const summary = page.summary.trim();
  if (summary) {
    line += ` — ${summary}`;
  }
  return line;
}

// Parse the group headings (## …) currently present inside the auto-section so
// a rebuild keeps their relative order. Returns the ordered list of heading
// labels.
function existingGroupOrder(autoSection: string): string[] {
  const order: string[] = [];
  for (const raw of autoSection.split('\n')) {
    const m = raw.match(/^##\s+(.+?)\s*$/);
    if (m) order.push(m[1]);
  }
  return order;
}

// Build the auto-section body: pages grouped by primary topic, groups ordered
// to preserve the existing index's group order (then new groups alphabetically,
// then the catch-all last), pages within a group sorted by filename.
function renderAutoSectionBody(
  pages: IndexPage[],
  priorGroupOrder: string[],
): string {
  // groupLabel -> pages
  const groups = new Map<string, IndexPage[]>();
  // Map a lower-cased label to the canonical label so an existing heading's
  // exact casing wins over a freshly Title-Cased token.
  const canonical = new Map<string, string>();
  for (const label of priorGroupOrder) {
    canonical.set(label.toLowerCase(), label);
  }

  for (const page of pages) {
    const primary = page.topics[0];
    let label: string;
    if (!primary) {
      label = UNCATEGORIZED_GROUP;
    } else {
      const titled = titleCaseTopic(primary);
      label = canonical.get(titled.toLowerCase()) ?? titled;
    }
    canonical.set(label.toLowerCase(), label);
    const bucket = groups.get(label);
    if (bucket) bucket.push(page);
    else groups.set(label, [page]);
  }

  const allLabels = [...groups.keys()];
  const priorSet = new Set(priorGroupOrder.map((l) => l.toLowerCase()));
  const ordered: string[] = [];
  // 1. Existing groups, in their prior order (only those that still have pages).
  for (const label of priorGroupOrder) {
    const canonLabel = canonical.get(label.toLowerCase());
    if (canonLabel && groups.has(canonLabel) && !ordered.includes(canonLabel)) {
      ordered.push(canonLabel);
    }
  }
  // 2. New groups (not in the prior order), alphabetical, catch-all excluded.
  const newGroups = allLabels
    .filter(
      (l) => !priorSet.has(l.toLowerCase()) && l !== UNCATEGORIZED_GROUP,
    )
    .sort((a, b) => a.localeCompare(b));
  for (const label of newGroups) {
    if (!ordered.includes(label)) ordered.push(label);
  }
  // 3. Catch-all group always last.
  if (groups.has(UNCATEGORIZED_GROUP) && !ordered.includes(UNCATEGORIZED_GROUP)) {
    ordered.push(UNCATEGORIZED_GROUP);
  }

  const blocks: string[] = [];
  for (const label of ordered) {
    const bucket = groups.get(label);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const lines = bucket.map(renderLine).join('\n');
    blocks.push(`## ${label}\n\n${lines}`);
  }

  if (blocks.length === 0) {
    return "_(empty — your sessions' wiki syncs will populate this list)_";
  }
  return blocks.join('\n\n');
}

// Splice ONLY the auto-section region of an existing index.md, preserving the
// header above the open marker and any user prose below the close marker
// byte-for-byte. When the file has no markers, append a fresh auto-section.
function spliceIndexAutoSection(indexText: string, newBody: string): string {
  const open = indexText.indexOf(AUTO_SECTION_OPEN);
  if (open === -1) {
    const base =
      indexText.endsWith('\n') || indexText === '' ? indexText : `${indexText}\n`;
    return `${base}\n${AUTO_SECTION_OPEN}\n\n${newBody}\n\n${AUTO_SECTION_CLOSE}\n`;
  }
  const innerStart = open + AUTO_SECTION_OPEN.length;
  const close = indexText.indexOf(AUTO_SECTION_CLOSE, innerStart);
  const before = indexText.slice(0, innerStart);
  if (close === -1) {
    // Open marker with no close — append a close after the rebuilt body so the
    // region is well-formed going forward. Everything before the open marker
    // is preserved.
    return `${before}\n\n${newBody}\n\n${AUTO_SECTION_CLOSE}\n`;
  }
  const after = indexText.slice(close);
  return `${before}\n\n${newBody}\n\n${after}`;
}

// Inner rebuild WITHOUT the wiki-chain wrapper. Callers already running inside
// runOnWikiChain (e.g. acceptProposal) MUST use this to avoid re-entering the
// chain and deadlocking.
export async function rebuildWikiIndexInner(root?: string): Promise<void> {
  const wikiRoot = root ?? getWikiRoot();
  const pagesDir = path.join(wikiRoot, 'pages');
  const indexFile = path.join(wikiRoot, 'index.md');

  const pages = await listIndexPages(pagesDir);

  let indexText: string;
  if (existsSync(indexFile)) {
    indexText = await readFile(indexFile, 'utf8');
  } else {
    indexText = `${DEFAULT_INDEX_HEADER}${AUTO_SECTION_OPEN}\n\n${AUTO_SECTION_CLOSE}\n`;
  }

  // Determine prior group order from the current auto-section (if any).
  const open = indexText.indexOf(AUTO_SECTION_OPEN);
  let priorGroupOrder: string[] = [];
  if (open !== -1) {
    const innerStart = open + AUTO_SECTION_OPEN.length;
    const close = indexText.indexOf(AUTO_SECTION_CLOSE, innerStart);
    const region =
      close === -1
        ? indexText.slice(innerStart)
        : indexText.slice(innerStart, close);
    priorGroupOrder = existingGroupOrder(region);
  }

  const body = renderAutoSectionBody(pages, priorGroupOrder);
  const next = spliceIndexAutoSection(indexText, body);

  await mkdir(wikiRoot, { recursive: true });
  await writeFile(indexFile, next, 'utf8');
}

// Public entry point — serializes onto the shared wiki write chain so it never
// races a concurrent sync/apply that also touches index.md.
export async function rebuildWikiIndex(root?: string): Promise<void> {
  return runOnWikiChain(() => rebuildWikiIndexInner(root));
}

// Exported for unit tests (pure-ish helpers).
export const _internal = {
  renderLine,
  renderAutoSectionBody,
  spliceIndexAutoSection,
  titleCaseTopic,
};
