// Normalized event stream produced by every agent adapter (Claude SDK,
// Codex CLI, …) and consumed by runner.ts. Adapters translate from their
// vendor-specific protocol to this small union; the orchestrator stays
// agnostic.

import type { ImageInput } from '../runner-types.js';
import type { UserPrompt } from './message-stream.js';

export type NormalizedEvent =
  // Tells us the resume token / thread id the agent is using. Persisted to
  // sessions.agent_session_id so the next turn can resume.
  | { type: 'session_id'; id: string }
  // Incremental text — Claude streams these as text_delta. Multiple events
  // accumulate into a single assistant message.
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  // Tool the agent is invoking (Bash/Read/Edit/Write etc).
  | {
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
      summary?: string;
    }
  // Output from a tool call. `stream` mirrors Claude's stdout/stderr split.
  | { type: 'tool_result'; text: string; stream: 'stdout' | 'stderr' }
  // Marks the end of a streamed assistant text block — finalize the
  // streaming chat row but keep the run going. Fires for SDK's actual
  // `message_stop` (end of an assistant message) AND right before a
  // `tool_use` block starts (so any in-flight text gets closed first).
  // Multiple per turn; runner uses it as a natural-break drain trigger
  // when text was actually streaming (vs the empty pre-tool case).
  | { type: 'text_block_end' }
  // Marks the end of a full turn — the agent has nothing more to say until
  // the next user prompt arrives. Used by the runner to roll over the
  // pending plan item id of a queued mid-run message.
  | { type: 'turn_complete' }
  // Rare Claude case: the SDK's final `result` event reports more text than
  // we accumulated via deltas. Orchestrator appends the missing tail.
  | { type: 'final_text_fallback'; text: string }
  // Actual model the agent reported using; stamped on the assistant row.
  | { type: 'model'; model: string };

export interface AgentRunArgs {
  cwd: string;
  systemPrompt: string;
  model?: string;
  /** Prior session/thread id; null = start fresh. */
  resume?: string | null;
  abortController: AbortController;
  /** First user message that kicks the run off. */
  initialPrompt: UserPrompt;
}

export interface AgentRun {
  /** Stream of normalized events from the agent. Ends when the run stops. */
  events: AsyncIterable<NormalizedEvent>;
  /** Inject another user message mid-run (no abort, no restart). */
  pushMessage(prompt: UserPrompt): void;
  /**
   * Signal "no more messages will arrive" — adapter wraps up after the
   * current turn finishes. Idempotent.
   */
  close(): void;
}

export interface AgentAdapter {
  readonly name: 'claude' | 'codex';
  run(args: AgentRunArgs): AgentRun;
}

// Re-export so callers don't need to know which file ImageInput lives in.
export type { ImageInput };
export type { UserPrompt };
