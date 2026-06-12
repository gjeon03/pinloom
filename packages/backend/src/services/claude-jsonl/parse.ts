// Pure functions that turn Claude Code transcript JSONL into the same
// `NormalizedEvent` stream the SDK/Codex adapters produce. No I/O here — the
// caller hands us already-read lines so this stays trivially unit-testable
// against recorded fixtures (the riskiest logic in the PTY path, isolated).
//
// Responsibilities:
//   1. parseJsonlLine    — one raw line -> typed JsonlLine (or null)
//   2. collectUuids      — snapshot the uuids present before a turn
//   3. selectTurnLines   — given that snapshot, the user/assistant lines that
//                          appeared since (this turn), dropping sidechain/noise/
//                          synthetic. A uuid diff, not a parentUuid walk —
//                          real claude threads turns through attachment lines.
//   4. toNormalizedEvents — those lines -> NormalizedEvent[]
//
// Reused by: the PTY completion detector (turn extraction) AND the usage meter
// / issue #21 progress bar (token accounting in ./usage.ts).

import type { NormalizedEvent } from '../agents/types.js';
import {
  NOISE_TYPES,
  SYNTHETIC_MODEL,
  type JsonlContentBlock,
  type JsonlLine,
} from './types.js';

/**
 * Parse a single transcript line. Returns null for blank lines, JSON parse
 * errors, or objects without a string `type` — callers skip nulls so a
 * partially-written tail line never throws.
 */
export function parseJsonlLine(raw: string): JsonlLine | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const line = obj as JsonlLine;
  if (typeof line.type !== 'string') return null;
  return line;
}

/** Parse a whole transcript blob, dropping unparseable lines. */
export function parseJsonlLines(raw: string): JsonlLine[] {
  const out: JsonlLine[] = [];
  for (const l of raw.split('\n')) {
    const parsed = parseJsonlLine(l);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isSynthetic(line: JsonlLine): boolean {
  return line.message?.model === SYNTHETIC_MODEL;
}

/** Every uuid currently present in the transcript — snapshot before a turn so
 *  the turn's new lines can be diffed out afterward. */
export function collectUuids(lines: JsonlLine[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) if (typeof l.uuid === 'string') out.add(l.uuid);
  return out;
}

/**
 * Select the user/assistant lines a turn produced, by diffing against the set of
 * uuids that existed before the prompt was submitted (`seenUuids`).
 *
 * Why a uuid diff rather than a parentUuid walk: real claude threads a turn's
 * user→assistant lines THROUGH intermediate `attachment` / `file-history-snapshot`
 * lines (the assistant's parentUuid points at an attachment, not the user line),
 * so a "descendants of the user message" walk breaks at every noise hop. Turns
 * are serialized per PTY session, so "lines that appeared since we snapshotted"
 * is both simpler and correct. A fresh session passes an empty set → the whole
 * transcript is the turn.
 *
 * Sidechain (subagent) lines, noise types, and synthetic messages are dropped.
 */
export function selectTurnLines(
  lines: JsonlLine[],
  seenUuids: ReadonlySet<string>,
): JsonlLine[] {
  return lines.filter(
    (l) =>
      (l.type === 'user' || l.type === 'assistant') &&
      !NOISE_TYPES.has(l.type) &&
      !l.isSidechain &&
      !isSynthetic(l) &&
      typeof l.uuid === 'string' &&
      !seenUuids.has(l.uuid),
  );
}

function blocksOf(line: JsonlLine): JsonlContentBlock[] {
  const content = line.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && 'text' in b) {
          const t = (b as { text?: unknown }).text;
          if (typeof t === 'string') return t;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Mirrors summarizeToolCall in claude-adapter.ts so the UI renders PTY tool
// calls identically to SDK ones.
export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${name}: ${input.command}`;
  if (typeof input.file_path === 'string') {
    const extra =
      typeof input.old_string === 'string'
        ? ' (edit)'
        : typeof input.content === 'string'
          ? ' (write)'
          : '';
    return `${name}: ${input.file_path}${extra}`;
  }
  if (typeof input.pattern === 'string') return `${name}: ${input.pattern}`;
  return name;
}

/**
 * Map already-extracted turn lines to the NormalizedEvent stream. Emits, in
 * order: a single `session_id` (if known) and `model` (first real model seen),
 * then per assistant block (thinking/text/tool_use) and per user tool_result,
 * and finally one `turn_complete`.
 *
 * Text blocks emit `text_delta` (full text) + `text_block_end`, matching how
 * the Codex adapter surfaces a completed message (the runner treats a
 * full-text delta the same as accumulated streaming deltas).
 */
export function toNormalizedEvents(
  turnLines: JsonlLine[],
  opts: { sessionId?: string | null } = {},
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (opts.sessionId) events.push({ type: 'session_id', id: opts.sessionId });

  let modelEmitted = false;

  for (const line of turnLines) {
    if (line.type === 'assistant') {
      const model = line.message?.model;
      if (!modelEmitted && model && model !== SYNTHETIC_MODEL) {
        events.push({ type: 'model', model });
        modelEmitted = true;
      }
      for (const block of blocksOf(line)) {
        if (block.type === 'thinking') {
          const text = typeof block.thinking === 'string' ? block.thinking : '';
          if (text) {
            events.push({ type: 'thinking_start' });
            events.push({ type: 'thinking_delta', text });
          }
        } else if (block.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) {
            events.push({ type: 'text_delta', text });
            events.push({ type: 'text_block_end' });
          }
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          events.push({
            type: 'tool_use',
            name,
            input,
            summary: summarizeToolCall(name, input),
          });
        }
      }
    } else if (line.type === 'user') {
      for (const block of blocksOf(line)) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content);
          if (text) {
            events.push({
              type: 'tool_result',
              text,
              stream: block.is_error ? 'stderr' : 'stdout',
            });
          }
        }
      }
    }
  }

  events.push({ type: 'turn_complete' });
  return events;
}
