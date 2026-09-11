// Parser for codex INTERACTIVE rollout JSONL (~/.codex/sessions or a pinloom
// CODEX_HOME's sessions/YYYY/MM/DD/rollout-*.jsonl). This is NOT the
// `codex exec --json` event stream the codex-adapter consumes — the interactive
// rollout has its own shape — so it's a separate parser. It produces the same
// kind of conversation rows pinloom's terminal capture persists for claude
// (user / assistant text + tool calls), in order.
//
// codex has shipped TWO rollout schemas and a session speaks exactly one of
// them (verified: rollouts written through 2026-09-04 carry only the first,
// rollouts from 2026-09-07 on carry only the second) — so handling both cannot
// double-count a turn. The newer one is why capture silently produced zero rows
// for a while: the tail still advanced its byte cursor, but nothing matched.
//
// Schema A (verified on codex-cli 0.133.0):
//   {type:'session_meta', payload:{id, cwd, cli_version, ...}}     ← resume token = id
//   {type:'event_msg', payload:{type:'user_message', message}}     ← clean user text
//   {type:'event_msg', payload:{type:'agent_message', message}}    ← clean assistant text
//   {type:'event_msg', payload:{type:'task_complete', turn_id, last_agent_message}}  ← turn boundary
//   {type:'response_item', payload:{type:'function_call', name, arguments, call_id}} ← tool call
//   {type:'response_item', payload:{type:'function_call_output', call_id, output}}   ← tool result
//   {type:'response_item', payload:{type:'message', role, content}}                  ← raw item (DUP of event_msg / env-context noise → skipped)
//
// Schema B (verified on codex-cli 0.154.0) — item-based, and message text is a
// block ARRAY rather than a plain string:
//   {type:'event_msg', payload:{type:'item_completed', item:{type:'UserMessage', content:[{type:'text', text}]}}}
//   {type:'event_msg', payload:{type:'item_completed', item:{type:'AgentMessage', content:[{type:'Text', text}], phase}}}
//   {type:'event_msg', payload:{type:'item_completed', item:{type:'Reasoning', ...}}}  ← skipped
//   {type:'response_item', payload:{type:'custom_tool_call', name, input, call_id}}    ← tool call
// Note the block `type` casing differs between the two roles ('text' vs 'Text'),
// so text extraction keys off the `text` field being a string, not the tag.
//
// Noise skipped in both: response_item:message (duplicates the event / carries
// <environment_context>/<permissions> developer+user scaffolding), token_count,
// turn_context, task_started, custom_tool_call_output.

export interface CodexRolloutLine {
  type?: string;
  payload?: { type?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CodexRow {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolUse?: { name: string; input: Record<string, unknown> };
}

export function parseRolloutText(text: string): CodexRolloutLine[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as CodexRolloutLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is CodexRolloutLine => l !== null);
}

/** codex's session id (resume token) from the rollout header, if present. */
export function rolloutSessionId(lines: CodexRolloutLine[]): string | null {
  const meta = lines.find((l) => l.type === 'session_meta');
  if (!meta) return null;
  const id = (meta.payload as { id?: unknown } | undefined)?.id ?? (meta as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function summarizeFunctionCall(name: string, argsJson: unknown): string {
  if (typeof argsJson === 'string') {
    try {
      const a = JSON.parse(argsJson) as Record<string, unknown>;
      const cmd = a.cmd ?? a.command;
      if (typeof cmd === 'string') return `${name}: ${cmd}`;
      const fp = a.path ?? a.file_path;
      if (typeof fp === 'string') return `${name}: ${fp}`;
    } catch {
      // fall through
    }
  }
  return name;
}

/**
 * Text of a schema-B message item. `content` is an array of blocks whose tag is
 * 'text' for user items and 'Text' for agent items, so match on the payload
 * (`text` being a string) rather than the tag. A plain string is accepted too,
 * in case a future version flattens it back.
 */
function itemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const text = (block as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * Schema-B tool calls carry `input` as a free-form code string, not the JSON
 * argument object `function_call` uses — so it goes through verbatim instead of
 * JSON.parse, and the summary takes its first line.
 */
function summarizeCustomToolCall(name: string, input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') return name;
  const firstLine = input.split('\n', 1)[0]!.trim();
  return `${name}: ${firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine}`;
}

function parseArgs(argsJson: unknown): Record<string, unknown> {
  if (typeof argsJson === 'string') {
    try {
      const a = JSON.parse(argsJson);
      if (a && typeof a === 'object') return a as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return {};
}

/**
 * Extract the conversation rows (user / tool / assistant, in order) from rollout
 * lines. Pass `lines.slice(cursor)` to get only a new turn's rows; the caller
 * advances its cursor by the number of lines consumed.
 */
export function parseRolloutRows(lines: CodexRolloutLine[]): CodexRow[] {
  const rows: CodexRow[] = [];
  for (const l of lines) {
    const pt = (l.payload as { type?: string } | undefined)?.type;
    if (l.type === 'event_msg') {
      const msg = (l.payload as { message?: unknown } | undefined)?.message;
      if (pt === 'user_message' && typeof msg === 'string' && msg.trim()) {
        rows.push({ role: 'user', content: msg });
      } else if (pt === 'agent_message' && typeof msg === 'string' && msg.trim()) {
        rows.push({ role: 'assistant', content: msg });
      } else if (pt === 'item_completed') {
        // Schema B. Reasoning items are deliberately dropped — pinloom stores
        // conversation rows, and codex's reasoning has no claude counterpart here.
        const item = (l.payload as { item?: { type?: string; content?: unknown } } | undefined)?.item;
        const role =
          item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'assistant' : null;
        if (role) {
          const text = itemText(item?.content);
          if (text.trim()) rows.push({ role, content: text });
        }
      }
      continue;
    }
    if (l.type === 'response_item') {
      const it = (l.payload ?? l) as {
        type?: string;
        name?: unknown;
        arguments?: unknown;
        input?: unknown;
      };
      if (it.type === 'function_call') {
        const name = typeof it.name === 'string' ? it.name : 'tool';
        rows.push({
          role: 'tool',
          content: summarizeFunctionCall(name, it.arguments),
          toolUse: { name, input: parseArgs(it.arguments) },
        });
      } else if (it.type === 'custom_tool_call') {
        // Schema B's tool call. Present in late schema-A rollouts too, where it
        // went uncaptured — harmless to pick up now, those are long consumed.
        const name = typeof it.name === 'string' ? it.name : 'tool';
        rows.push({
          role: 'tool',
          content: summarizeCustomToolCall(name, it.input),
          toolUse: { name, input: typeof it.input === 'string' ? { input: it.input } : {} },
        });
      }
      // function_call_output, custom_tool_call_output, message, etc. are skipped.
    }
  }
  return rows;
}

/** Number of `task_complete` turn boundaries present in the lines. */
export function countTaskComplete(lines: CodexRolloutLine[]): number {
  let n = 0;
  for (const l of lines) {
    if (l.type === 'event_msg' && (l.payload as { type?: string } | undefined)?.type === 'task_complete') {
      n++;
    }
  }
  return n;
}

/** The most recent `task_complete.last_agent_message` (dispatch reply), if any. */
export function lastAgentMessage(lines: CodexRolloutLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type === 'event_msg' && (l.payload as { type?: string } | undefined)?.type === 'task_complete') {
      const m = (l.payload as { last_agent_message?: unknown }).last_agent_message;
      if (typeof m === 'string') return m;
    }
  }
  return null;
}
