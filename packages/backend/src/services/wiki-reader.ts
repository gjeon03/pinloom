import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIKI_ROOT = path.join(os.homedir(), '.pinloom', 'wiki');
const PAGES_DIR = path.join(WIKI_ROOT, 'pages');
const INDEX_FILE = path.join(WIKI_ROOT, 'index.md');
const SCHEMA_FILE = path.join(WIKI_ROOT, '_schema.md');

export interface ParsedFrontmatter {
  appliesTo: string[];
  topic: string[];
  related: string[];
  summary: string;
}

export interface WikiPage {
  filename: string;
  relPath: string;
  title: string;
  meta: ParsedFrontmatter;
  body: string;
  rawBody: string;
  isPromotedDir: boolean;
}

const FM_FENCE = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;

function parseLine(line: string): { key: string; value: string } | null {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
  if (!m) return null;
  return { key: m[1], value: m[2].trim() };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseArray(value: string): string[] {
  const m = value.match(/^\[(.*)\]$/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

export function parseFrontmatter(body: string): {
  meta: ParsedFrontmatter;
  rest: string;
} {
  const match = body.match(FM_FENCE);
  const empty: ParsedFrontmatter = {
    appliesTo: [],
    topic: [],
    related: [],
    summary: '',
  };
  if (!match) return { meta: empty, rest: body };

  const out: ParsedFrontmatter = { ...empty };
  for (const rawLine of match[1].split('\n')) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    switch (parsed.key) {
      case 'applies_to':
        out.appliesTo = parseArray(parsed.value);
        break;
      case 'topic':
        out.topic = parseArray(parsed.value);
        break;
      case 'related':
        out.related = parseArray(parsed.value);
        break;
      case 'summary':
        out.summary = unquote(parsed.value);
        break;
    }
  }
  // Drop the leading frontmatter block + the trailing newline that the fence
  // captured so the body starts cleanly.
  const rest = body.slice(match[0].length).replace(/^\n/, '');
  return { meta: out, rest };
}

function extractTitleFromBody(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return '';
}

async function readPageEntry(
  fullPath: string,
  relPath: string,
  isPromotedDir: boolean,
): Promise<WikiPage> {
  const rawBody = await readFile(fullPath, 'utf8');
  const { meta, rest } = parseFrontmatter(rawBody);
  const title = extractTitleFromBody(rest) || relPath.replace(/\.md$/, '');
  return {
    filename: relPath,
    relPath,
    title,
    meta,
    body: rest,
    rawBody,
    isPromotedDir,
  };
}

export async function listWikiPages(): Promise<WikiPage[]> {
  if (!existsSync(PAGES_DIR)) return [];
  const out: WikiPage[] = [];
  const entries = await readdir(PAGES_DIR);
  for (const entry of entries) {
    const full = path.join(PAGES_DIR, entry);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const inner = path.join(full, 'index.md');
      if (existsSync(inner)) {
        out.push(await readPageEntry(inner, `${entry}/index.md`, true));
      }
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    out.push(await readPageEntry(full, entry, false));
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

export async function readWikiPage(filename: string): Promise<WikiPage | null> {
  // Reject path traversal — accept only entries under pages/.
  const normalized = path.posix.normalize(filename);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;

  const full = path.join(PAGES_DIR, normalized);
  if (!full.startsWith(PAGES_DIR + path.sep) && full !== PAGES_DIR) return null;

  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) return null;
  return readPageEntry(full, normalized, normalized.endsWith('/index.md'));
}

export interface WikiOverview {
  pages: WikiPage[];
  index: string | null;
  schema: string | null;
  wikiRoot: string;
}

export async function getWikiOverview(): Promise<WikiOverview> {
  const pages = await listWikiPages();
  const index = existsSync(INDEX_FILE) ? await readFile(INDEX_FILE, 'utf8') : null;
  const schema = existsSync(SCHEMA_FILE) ? await readFile(SCHEMA_FILE, 'utf8') : null;
  return { pages, index, schema, wikiRoot: WIKI_ROOT };
}

export function resolveAbsolutePageFile(filename: string): string | null {
  const normalized = path.posix.normalize(filename);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const full = path.join(PAGES_DIR, normalized);
  if (!full.startsWith(PAGES_DIR + path.sep) && full !== PAGES_DIR) return null;
  return full;
}

export function getPagesDir(): string {
  return PAGES_DIR;
}

export function getIndexFile(): string {
  return INDEX_FILE;
}

export function getSchemaFile(): string {
  return SCHEMA_FILE;
}

export function getWikiRoot(): string {
  return WIKI_ROOT;
}
