// Raw shapes of the lines Claude Code writes to its session transcript at
// `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. One JSON object per line.
//
// We deliberately type only the fields the parser reads and keep everything
// `?`-optional + defensively narrowed at the use site: the transcript schema
// is owned by the Claude CLI and can shift across versions, so the parser must
// degrade (skip a line) rather than throw on an unexpected shape.

export type JsonlTopLevelType =
  | 'assistant'
  | 'user'
  // Metadata / noise the parser ignores for turn extraction:
  | 'attachment'
  | 'file-history-snapshot'
  | 'system'
  | 'pr-link'
  | 'permission-mode'
  | 'ai-title'
  | 'last-prompt'
  | 'agent-name'
  | 'queue-operation'
  | 'mode'
  | (string & {});

// Top-level types that carry no turn content — skipped during extraction.
export const NOISE_TYPES: ReadonlySet<string> = new Set([
  'attachment',
  'file-history-snapshot',
  'system',
  'pr-link',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'agent-name',
  'queue-operation',
  'mode',
]);

// Model id the CLI stamps on synthetic (non-billed, compaction/error) assistant
// messages. Excluded from token accounting and event mapping.
export const SYNTHETIC_MODEL = '<synthetic>';

export interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface JsonlContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block (appears inside a `user` message)
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface JsonlMessage {
  role?: 'assistant' | 'user' | string;
  model?: string;
  content?: string | JsonlContentBlock[];
  usage?: JsonlUsage;
  stop_reason?: string | null;
}

export interface JsonlLine {
  type: JsonlTopLevelType;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  requestId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: JsonlMessage;
}
