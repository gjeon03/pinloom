// Write side of the wiki reader. The editor on the frontend hands us a
// body + frontmatter pair and we serialise them back to disk in the
// same shape parseFrontmatter expects so a round-trip read returns the
// equivalent object.

import { writeFile } from 'node:fs/promises';
import {
  type ParsedFrontmatter,
  resolveAbsolutePageFile,
} from './wiki-reader.js';

export class WikiWriteError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'WikiWriteError';
  }
}

// Quote a string only when needed — arrays of plain slugs read cleaner
// without quotes, but anything containing a comma, quote, or wrapping
// whitespace has to be wrapped to survive the parser.
function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function serializeArray(items: string[]): string {
  return `[${items.map(quoteIfNeeded).join(', ')}]`;
}

export function serializeFrontmatter(meta: ParsedFrontmatter): string {
  const lines: string[] = [
    `applies_to: ${serializeArray(meta.appliesTo)}`,
    `topic: ${serializeArray(meta.topic)}`,
    `related: ${serializeArray(meta.related)}`,
  ];
  if (meta.summary.length > 0) {
    lines.push(`summary: ${JSON.stringify(meta.summary)}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

export interface WikiUpdateInput {
  meta: ParsedFrontmatter;
  body: string;
}

function normalizeMeta(raw: unknown): ParsedFrontmatter {
  if (!raw || typeof raw !== 'object') {
    throw new WikiWriteError('meta must be an object');
  }
  const obj = raw as Record<string, unknown>;
  function asStringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new WikiWriteError(`meta.${field} must be an array of strings`);
    }
    return value.map((v, i) => {
      if (typeof v !== 'string') {
        throw new WikiWriteError(`meta.${field}[${i}] must be a string`);
      }
      return v.trim();
    }).filter((v) => v.length > 0);
  }
  const summary = obj.summary;
  if (summary !== undefined && typeof summary !== 'string') {
    throw new WikiWriteError('meta.summary must be a string');
  }
  return {
    appliesTo: asStringArray(obj.appliesTo, 'appliesTo'),
    topic: asStringArray(obj.topic, 'topic'),
    related: asStringArray(obj.related, 'related'),
    summary: typeof summary === 'string' ? summary.trim() : '',
  };
}

export async function writeWikiPage(
  filename: string,
  input: { meta: unknown; body: unknown },
): Promise<void> {
  const full = resolveAbsolutePageFile(filename);
  if (!full) {
    throw new WikiWriteError('invalid filename', 400);
  }
  if (typeof input.body !== 'string') {
    throw new WikiWriteError('body must be a string', 400);
  }
  const meta = normalizeMeta(input.meta);
  // Normalize the body so we always emit exactly one trailing newline
  // — the parser already strips a leading one after the frontmatter
  // block, but matching the canonical shape avoids spurious diffs.
  const body = input.body.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  const fm = serializeFrontmatter(meta);
  await writeFile(full, `${fm}\n${body}`, 'utf8');
}
