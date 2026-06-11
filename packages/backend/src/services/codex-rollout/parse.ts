// Parser for codex INTERACTIVE rollout JSONL (~/.codex/sessions or a pinloom
// CODEX_HOME's sessions/YYYY/MM/DD/rollout-*.jsonl). This is NOT the
// `codex exec --json` event stream the codex-adapter consumes — the interactive
// rollout has its own shape — so it's a separate parser. It produces the same
// kind of conversation rows pinloom's terminal capture persists for claude
// (user / assistant text + tool calls), in order.
//
// Rollout line shapes (verified on codex-cli 0.133.0):
//   {type:'session_meta', payload:{id, cwd, cli_version, ...}}     ← resume token = id
//   {type:'event_msg', payload:{type:'user_message', message}}     ← clean user text
//   {type:'event_msg', payload:{type:'agent_message', message}}    ← clean assistant text
//   {type:'event_msg', payload:{type:'task_complete', turn_id, last_agent_message}}  ← turn boundary
//   {type:'response_item', payload:{type:'function_call', name, arguments, call_id}} ← tool call
//   {type:'response_item', payload:{type:'function_call_output', call_id, output}}   ← tool result
//   {type:'response_item', payload:{type:'message', role, content}}                  ← raw item (DUP of event_msg / env-context noise → skipped)
// Noise skipped: response_item:message (duplicates event_msg / carries
// <environment_context>/<permissions> developer+user scaffolding), token_count,
// turn_context, task_started.

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
      }
      continue;
    }
    if (l.type === 'response_item') {
      const it = (l.payload ?? l) as { type?: string; name?: unknown; arguments?: unknown };
      if (it.type === 'function_call') {
        const name = typeof it.name === 'string' ? it.name : 'tool';
        rows.push({
          role: 'tool',
          content: summarizeFunctionCall(name, it.arguments),
          toolUse: { name, input: parseArgs(it.arguments) },
        });
      }
      // function_call_output, message, etc. are skipped (see header).
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
