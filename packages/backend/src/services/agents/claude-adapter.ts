// Wraps @anthropic-ai/claude-agent-sdk's `query` so the runner.ts
// orchestrator can consume the same NormalizedEvent stream for any agent.
// User prompts arrive via a UserPromptStream — the first one kicks the
// run off, additional ones (mid-run injection from sendUserMessage) are
// surfaced to the SDK's prompt AsyncIterable so it picks them up at the
// next turn boundary instead of restarting.

import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import type { ImageInput, ImageMediaType } from '../runner-types.js';
import { UserPromptStream } from './message-stream.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
  UserPrompt,
} from './types.js';

interface PromptTextBlock {
  type: 'text';
  text: string;
}
interface PromptImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
}
type PromptContentBlock = PromptTextBlock | PromptImageBlock;

function buildContentBlocks(text: string, images: ImageInput[]): PromptContentBlock[] {
  const blocks: PromptContentBlock[] = [];
  if (text.length > 0) blocks.push({ type: 'text', text });
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
    });
  }
  return blocks;
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text;
          if (typeof t === 'string') return t;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface SdkAssistantMessage {
  id?: string;
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
}

interface SdkUserMessage {
  content?: Array<{
    type: string;
    content?: unknown;
    is_error?: boolean;
  }>;
}

interface SdkStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
  };
  content_block?: { type?: string; text?: string; name?: string; input?: unknown };
}

interface SdkResultMessage {
  subtype?: string;
  result?: string;
  session_id?: string;
}

class ClaudeAdapterImpl implements AgentAdapter {
  readonly name = 'claude' as const;

  run(args: AgentRunArgs): AgentRun {
    const promptStream = new UserPromptStream();
    promptStream.push(args.initialPrompt);

    // SDK reads from this AsyncIterable. We yield each queued user message
    // and end when the stream closes.
    async function* sdkPromptIterable() {
      for await (const p of promptStream) {
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: buildContentBlocks(p.text, p.images),
          },
          parent_tool_use_id: null,
        };
      }
    }

    // When the caller provided a static/dynamic split, pass it to the SDK
    // as a block array with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between them.
    // The SDK keeps the static prefix in its prompt cache across turns;
    // editing a pin or plan item only invalidates the suffix instead of
    // busting the cache for the whole prompt. Falls back to a single
    // string for the legacy path so behavior is unchanged when the runner
    // doesn't supply a split.
    const systemPromptOption =
      args.systemPromptDynamic !== undefined
        ? [args.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, args.systemPromptDynamic]
        : args.systemPrompt;

    // Map our cross-agent effort level onto the SDK's `thinking` option.
    // 'adaptive' is the SDK default (let the model decide); explicit
    // budget_tokens for higher tiers picks a fixed ceiling that scales
    // roughly with the perceived 'extra effort' the user is asking for.
    let thinkingOption: { type: string; budget_tokens?: number };
    switch (args.reasoningEffort) {
      case 'low':
        thinkingOption = { type: 'disabled' };
        break;
      case 'high':
        thinkingOption = { type: 'enabled', budget_tokens: 8000 };
        break;
      case 'xhigh':
        thinkingOption = { type: 'enabled', budget_tokens: 16000 };
        break;
      case 'max':
        thinkingOption = { type: 'enabled', budget_tokens: 32000 };
        break;
      case 'medium':
      default:
        thinkingOption = { type: 'adaptive' };
        break;
    }

    const options: Record<string, unknown> = {
      cwd: args.cwd,
      systemPrompt: systemPromptOption,
      // No maxTurns ceiling — pinloom is single-user and the cancel button
      // covers runaway loops.
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(command:*)'],
      // Pull in the user's Claude Code environment — `~/.claude/` (skills,
      // subagents, slash commands, hooks, MCP servers) and the project's
      // `.claude/` + CLAUDE.md. The SDK defaults to `[]` ("isolation mode")
      // which is why pinloom workers couldn't see any of that even though
      // the files were present on disk.
      settingSources: ['user', 'project'],
      abortController: args.abortController,
      includePartialMessages: true,
      thinking: thinkingOption,
    };
    if (args.resume) options.resume = args.resume;
    // Fork on resume to switch the model mid-conversation (a plain `--resume`
    // pins the thread to its original model and ignores `--model`). `--fork-session`
    // branches into a new session that honors the model while keeping context.
    if (args.resume && args.forkSession) options.forkSession = true;
    if (args.model) options.model = args.model;
    if (args.mcpServers) {
      // SDK accepts McpStdioServerConfig literally, plus an optional
      // `type: 'stdio'` discriminator. Sticking to {command, args, env}
      // matches the adapter-agnostic shape we get from runner.ts.
      options.mcpServers = args.mcpServers;
    }

    const q = query({
      prompt: sdkPromptIterable() as Parameters<typeof query>[0]['prompt'],
      options: options as Parameters<typeof query>[0]['options'],
    });

    let totalText = '';

    async function* events(): AsyncGenerator<NormalizedEvent> {
      try {
        for await (const message of q) {
          if (args.abortController.signal.aborted) break;
          const anyMsg = message as unknown as {
            type: string;
            event?: SdkStreamEvent;
            message?: SdkAssistantMessage | SdkUserMessage;
            session_id?: string;
          };

          if (anyMsg.type === 'stream_event') {
            const ev = anyMsg.event;
            if (!ev) continue;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const delta = ev.delta.text ?? '';
              if (delta) {
                totalText += delta;
                yield { type: 'text_delta', text: delta };
              }
            } else if (
              ev.type === 'content_block_delta' &&
              ev.delta?.type === 'thinking_delta'
            ) {
              const delta = ev.delta.thinking ?? '';
              if (delta) yield { type: 'thinking_delta', text: delta };
            } else if (
              ev.type === 'content_block_start' &&
              ev.content_block?.type === 'thinking'
            ) {
              yield { type: 'thinking_start' };
            } else if (
              ev.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              // SDK is about to start a tool_use block — close any
              // in-flight streamed text first.
              yield { type: 'text_block_end' };
            } else if (ev.type === 'message_stop') {
              // End of an assistant message block from the SDK.
              yield { type: 'text_block_end' };
            }
            continue;
          }

          if (anyMsg.type === 'assistant') {
            if (anyMsg.session_id) {
              yield { type: 'session_id', id: anyMsg.session_id };
            }
            const asst = anyMsg.message as SdkAssistantMessage | undefined;
            if (asst?.model) yield { type: 'model', model: asst.model };
            const content = asst?.content ?? [];
            for (const block of content) {
              if (block.type === 'tool_use') {
                const input = (block.input ?? {}) as Record<string, unknown>;
                const name = block.name ?? 'tool';
                yield {
                  type: 'tool_use',
                  name,
                  input,
                  summary: summarizeToolCall(name, input),
                };
              }
            }
          } else if (anyMsg.type === 'user') {
            const usr = anyMsg.message as SdkUserMessage | undefined;
            const content = usr?.content ?? [];
            for (const block of content) {
              if (block.type === 'tool_result') {
                const text = toolResultText(block.content);
                if (text) {
                  yield {
                    type: 'tool_result',
                    text,
                    stream: block.is_error ? 'stderr' : 'stdout',
                  };
                }
              }
            }
          } else if (anyMsg.type === 'result') {
            const result = message as unknown as SdkResultMessage;
            if (result.session_id) {
              yield { type: 'session_id', id: result.session_id };
            }
            if (
              result.subtype === 'success' &&
              result.result &&
              result.result.length > totalText.length
            ) {
              const tail = result.result.slice(totalText.length);
              totalText += tail;
              yield { type: 'final_text_fallback', text: tail };
            }
            // SDK signals end-of-turn with `result`. Reset the per-turn text
            // accumulator so the next turn's final_text_fallback diff is
            // computed against zero, not against accumulated history.
            totalText = '';
            yield { type: 'turn_complete' };
          }
        }
      } finally {
        try {
          const maybeClose = (q as unknown as { close?: () => void }).close;
          if (typeof maybeClose === 'function') maybeClose.call(q);
        } catch {
          // best-effort cleanup
        }
      }
    }

    return {
      events: events(),
      pushMessage(prompt: UserPrompt) {
        promptStream.push(prompt);
      },
      close() {
        promptStream.close();
        try {
          const maybeClose = (q as unknown as { close?: () => void }).close;
          if (typeof maybeClose === 'function') maybeClose.call(q);
        } catch {
          // best-effort
        }
      },
    };
  }
}

export const claudeAdapter: AgentAdapter = new ClaudeAdapterImpl();
