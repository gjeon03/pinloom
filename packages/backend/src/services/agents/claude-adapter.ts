// Wraps @anthropic-ai/claude-agent-sdk's `query` so the runner.ts
// orchestrator can consume the same NormalizedEvent stream for any agent.
// The translation logic was the for-await loop inside the old
// runner.ts#runAttempt — we just relocate it and re-emit normalized events
// instead of broadcasting/persisting inline.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ImageInput, ImageMediaType } from '../runner-types.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
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

async function* buildPromptIterable(text: string, images: ImageInput[]) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: buildContentBlocks(text, images) },
    parent_tool_use_id: null,
  };
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
    const options: Record<string, unknown> = {
      cwd: args.cwd,
      systemPrompt: args.systemPrompt,
      // 100 is generous enough that legitimate codebase-exploration turns
      // (grep + read + edit cycles) don't bump the ceiling, while still
      // catching genuine runaway loops. The user can always abort sooner.
      maxTurns: 100,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(command:*)'],
      abortController: args.abortController,
      includePartialMessages: true,
      thinking: { type: 'adaptive' },
    };
    if (args.resume) options.resume = args.resume;
    if (args.model) options.model = args.model;

    const promptValue =
      args.images && args.images.length > 0
        ? buildPromptIterable(args.prompt, args.images)
        : args.prompt;

    const q = query({
      prompt: promptValue as Parameters<typeof query>[0]['prompt'],
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
              // The full tool_use (with input args) arrives in the
              // 'assistant' event below; the start marker just tells us to
              // close any in-flight streamed text first.
              yield { type: 'message_stop' };
            } else if (ev.type === 'message_stop') {
              yield { type: 'message_stop' };
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
            // Rare edge case: result text exceeds what we streamed (the SDK
            // sometimes catches up here). Forward the missing tail so
            // orchestrator can append.
            if (
              result.subtype === 'success' &&
              result.result &&
              result.result.length > totalText.length
            ) {
              const tail = result.result.slice(totalText.length);
              totalText += tail;
              yield { type: 'final_text_fallback', text: tail };
            }
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
      close() {
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
