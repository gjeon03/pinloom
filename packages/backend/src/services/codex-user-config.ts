// Inheriting the user's own `[mcp_servers.*]` from their real ~/.codex/config.toml.
//
// pinloom never lets a spawned codex touch the real ~/.codex: terminal sessions
// get a stable per-session CODEX_HOME (codex-pty/launch-spec.ts) and SDK
// orchestrator runs get a temp one (agents/codex-adapter.ts). Both GENERATE
// their config.toml from scratch on every spawn, which kept the rollout files
// isolated — but also meant a pinloom codex session started with ZERO MCP
// servers, and a `codex mcp add` run inside one was silently overwritten by the
// next spawn (it lands in the per-session home, not the user's real config).
//
// So we copy the user's `[mcp_servers.*]` tables across as RAW TOML TEXT rather
// than re-serializing a parsed model. codex supports several server shapes —
// stdio (`command`/`args`/`env`), remote (`url`), per-tool approval
// sub-tables (`[mcp_servers.x.tools.y]`), `enabled`, `startup_timeout_sec` — and
// a verbatim copy carries all of them, including keys we don't know about.
//
// Deliberately NOT inherited: `[plugins.*]` / `[marketplaces.*]` (they resolve
// against the real home's caches, so re-homing them invites startup failures).
// Model defaults are inherited separately, before any TOML tables. Explicit
// session selections still win through `--model` / `-c`. The source is re-read
// on every spawn, so edits to ~/.codex/config.toml land in the next launch.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Split a dotted TOML key path into segments, honoring "quoted" / 'literal'
 * segments so `mcp_servers."my-server".env` yields three parts and a dot inside
 * quotes doesn't split.
 */
export function splitDottedKey(key: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    parts.push(quoted ? current : current.trim());
    current = '';
    quoted = false;
  };

  for (const ch of key) {
    if (quote) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (quote === '"' && ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      if (current.trim() === '') current = ''; // drop the whitespace before the quote
      continue;
    }
    if (ch === '.') {
      push();
      continue;
    }
    // Once a segment is quoted its value is fixed; anything still outside the
    // quotes can only be the whitespace TOML allows around a dotted-key part.
    if (!quoted) current += ch;
  }
  push();
  return parts;
}

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

/** Toggle multi-line-string state for a line, so a `[` inside one isn't read as a header. */
function trackMultiline(line: string, open: string | null): string | null {
  let state = open;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    if ((state === '"""' || quote === '"') && line[i] === '\\') {
      i++;
      continue;
    }
    const three = line.slice(i, i + 3);
    if (state) {
      if (three === state) {
        state = null;
        i += 2;
      }
    } else if (quote) {
      if (line[i] === quote) quote = null;
    } else if (line[i] === '#') {
      break;
    } else if (three === '"""' || three === "'''") {
      state = three;
      i += 2;
    } else if (line[i] === '"' || line[i] === "'") {
      quote = line[i];
    }
  }
  return state;
}

/**
 * Pull every `[mcp_servers.<name>…]` table out of a config.toml, verbatim.
 * Servers whose name is in `exclude` are dropped so pinloom's own entries can
 * never be shadowed by a same-named user server.
 */
export function extractMcpServerTables(text: string, exclude: Set<string>): string[] {
  return extractTables(text, (segments) =>
    segments.length >= 2 &&
    segments[0] === 'mcp_servers' &&
    segments[1].length > 0 &&
    !exclude.has(segments[1]),
  );
}

function extractTables(text: string, include: (segments: string[]) => boolean): string[] {
  const blocks: string[] = [];
  let block: string[] = [];
  let keep = false;
  let multiline: string | null = null;

  const flush = () => {
    if (keep) {
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
      if (block.length > 0) blocks.push(block.join('\n'));
    }
    block = [];
    keep = false;
  };

  for (const line of text.split('\n')) {
    if (multiline === null) {
      const header = TABLE_HEADER.exec(line);
      if (header) {
        flush();
        const segments = splitDottedKey(header[1]);
        keep = include(segments);
        if (keep) block.push(line);
        continue;
      }
    }
    if (keep) block.push(line);
    multiline = trackMultiline(line, multiline);
  }
  flush();
  return blocks;
}

const MODEL_KEYS = new Set([
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_context_window',
  'model_auto_compact_token_limit',
  'service_tier',
]);

/** Model defaults for an isolated home. Emit before any generated TOML tables. */
export function inheritedModelToml(sourceHome: string): string {
  let text: string;
  try {
    text = readFileSync(path.join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return '';
  }

  const lines: string[] = [];
  let multiline: string | null = null;
  let keep = false;
  for (const line of text.split('\n')) {
    if (multiline === null) {
      if (TABLE_HEADER.test(line)) break;
      const assignment = /^\s*([^=]+?)\s*=/.exec(line);
      const segments = assignment ? splitDottedKey(assignment[1]) : [];
      keep = (segments.length === 1 && MODEL_KEYS.has(segments[0])) ||
        segments[0] === 'model_providers';
    }
    if (keep) lines.push(line);
    multiline = trackMultiline(line, multiline);
  }
  // A custom provider must accompany model_provider or Codex cannot resolve it.
  lines.push(...extractTables(text, (segments) => segments[0] === 'model_providers'));
  return lines.join('\n');
}

/**
 * The user's `[mcp_servers.*]` tables as a TOML fragment ready to append to a
 * generated config.toml. Empty string when there is no readable user config or
 * it declares no servers.
 *
 * `sourceHome` is the user's REAL codex home (`$CODEX_HOME` or ~/.codex) — never
 * a pinloom-generated one, or a session would re-inherit its own copy.
 */
export function inheritedMcpServerToml(
  sourceHome: string,
  exclude: Iterable<string> = [],
): string {
  let text: string;
  try {
    text = readFileSync(path.join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return ''; // no user config yet, or unreadable — nothing to inherit
  }
  const blocks = extractMcpServerTables(text, new Set(exclude));
  if (blocks.length === 0) return '';
  return [
    '# --- inherited from the user\'s codex config by pinloom ---',
    ...blocks,
  ].join('\n\n');
}
