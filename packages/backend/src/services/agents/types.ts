// Normalized event stream produced by every agent adapter (Claude SDK,
// Codex CLI, …) and consumed by runner.ts. Adapters translate from their
// vendor-specific protocol to this small union; the orchestrator stays
// agnostic.

import type { ImageInput } from '../runner-types.js';

export type NormalizedEvent =
  // Tells us the resume token / thread id the agent is using. Persisted to
  // sessions.agent_session_id so the next turn can resume.
  | { type: 'session_id'; id: string }
  // Incremental text — Claude streams these as text_delta. Multiple events
  // accumulate into a single assistant message.
  | { type: 'text_delta'; text: string }
  // Whole text emitted in one shot (Codex agent_message). Treated as a
  // single text_delta + message_stop equivalent at the orchestrator layer.
  | { type: 'text_complete'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  // Tool the agent is invoking (Bash/Read/Edit/Write etc). `name` and
  // `input` mirror Claude's shape; the codex adapter packs its
  // file_change / command_execution events into the same shape.
  | {
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
      summary?: string;
    }
  // Output from a tool call. `stream` mirrors Claude's stdout/stderr split.
  | { type: 'tool_result'; text: string; stream: 'stdout' | 'stderr' }
  // Marks the end of an in-flight assistant message (Claude message_stop or
  // Codex turn.completed). Orchestrator finalizes the streamed row here.
  | { type: 'message_stop' }
  // Rare Claude case: the SDK's final `result` event reports more text than
  // we accumulated via deltas. Orchestrator appends the missing tail.
  | { type: 'final_text_fallback'; text: string }
  // Actual model the agent reported using; stamped on the assistant row.
  | { type: 'model'; model: string };

export interface AgentRunArgs {
  cwd: string;
  prompt: string;
  images?: ImageInput[];
  systemPrompt: string;
  model?: string;
  /** Prior session/thread id; null = start fresh. */
  resume?: string | null;
  abortController: AbortController;
}

export interface AgentRun {
  events: AsyncIterable<NormalizedEvent>;
  close: () => void;
}

export interface AgentAdapter {
  readonly name: 'claude' | 'codex';
  run(args: AgentRunArgs): AgentRun;
}
