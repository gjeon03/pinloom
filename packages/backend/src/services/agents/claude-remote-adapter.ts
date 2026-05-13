// Remote-control variant of the Claude adapter. Wraps
// `runAssistantWorker` from @anthropic-ai/claude-agent-sdk/assistant so the
// worker is exposed on claude.ai via the Anthropic bridge.
//
// Wiring:
//   - Pinloom local UI input → `handle.pushPrompt(content)` (skips bridge)
//   - claude.ai remote input  → bridge forwards into the worker for us
//   - All outbound SDK messages → `transformOutbound` callback, which we
//     convert to pinloom's NormalizedEvent stream and feed back into the
//     runner so chat history is persisted the same way as the local
//     adapter.
//
// Selection: runner.ts picks this adapter via agents/index.ts when the
// session has been marked as remote-control (env-var activation in PR 1;
// per-session SQLite flag arrives in PR 2/3).

import { runAssistantWorker } from '@anthropic-ai/claude-agent-sdk/assistant';
import type { ImageInput, ImageMediaType } from '../runner-types.js';
import { UserPromptStream } from './message-stream.js';
import {
  loadRemoteCredentials,
  invalidateRemoteCredentials,
  CredentialError,
} from './claude-remote-credentials.js';
import { createWorkerStateAdapter } from './claude-remote-state.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
  UserPrompt,
} from './types.js';

// ─── prompt content helpers ─────────────────────────────────────────────

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

// ─── SDK → NormalizedEvent converter ────────────────────────────────────
// Mirrors claude-adapter.ts. Deliberately duplicated rather than shared:
// PR 1 keeps the local adapter completely untouched, and the converter
// will be extracted into a shared helper in a follow-up refactor once
// remote-control stabilizes.

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

// Per-run text accumulator so result.result can be diffed against deltas.
interface ConvertState {
  totalText: string;
}

function* convertSdkMessage(
  message: unknown,
  state: ConvertState,
): Generator<NormalizedEvent> {
  const anyMsg = message as {
    type: string;
    event?: SdkStreamEvent;
    message?: SdkAssistantMessage | SdkUserMessage;
    session_id?: string;
  };

  if (anyMsg.type === 'stream_event') {
    const ev = anyMsg.event;
    if (!ev) return;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const delta = ev.delta.text ?? '';
      if (delta) {
        state.totalText += delta;
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
      yield { type: 'text_block_end' };
    } else if (ev.type === 'message_stop') {
      yield { type: 'text_block_end' };
    }
    return;
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
    return;
  }

  if (anyMsg.type === 'user') {
    const usr = anyMsg.message as SdkUserMessage | undefined;
    const content = usr?.content ?? [];
    // The local adapter only ever sees `tool_result` blocks in SDK
    // user messages, because pinloom UI input is persisted in
    // routes/sessions.ts before the adapter runs. In the remote
    // adapter, claude.ai inbound prompts ALSO arrive as SDK user
    // messages — but with text content. Capture those so the
    // pinloom-side history isn't missing half the conversation.
    let inboundText = '';
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
      } else if (block.type === 'text') {
        const t = (block as { text?: unknown }).text;
        if (typeof t === 'string') inboundText += t;
      }
    }
    if (inboundText.length > 0) {
      yield { type: 'inbound_user_message', text: inboundText };
    }
    return;
  }

  if (anyMsg.type === 'result') {
    const result = message as SdkResultMessage;
    if (result.session_id) {
      yield { type: 'session_id', id: result.session_id };
    }
    if (
      result.subtype === 'success' &&
      result.result &&
      result.result.length > state.totalText.length
    ) {
      const tail = result.result.slice(state.totalText.length);
      state.totalText += tail;
      yield { type: 'final_text_fallback', text: tail };
    }
    state.totalText = '';
    yield { type: 'turn_complete' };
  }
}

// ─── push/pull adapter for transformOutbound → AsyncIterable ────────────

class AsyncEventQueue<T> {
  private values: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const next = this.resolvers.shift();
    if (next) {
      next({ value: v, done: false });
    } else {
      this.values.push(v);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift();
      r?.({ value: undefined as unknown as T, done: true });
    }
  }

  iterator(): AsyncGenerator<T> {
    const self = this;
    return (async function* () {
      while (true) {
        if (self.values.length > 0) {
          yield self.values.shift() as T;
          continue;
        }
        if (self.closed) return;
        const next = await new Promise<IteratorResult<T>>((resolve) => {
          self.resolvers.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    })();
  }
}

// ─── adapter ────────────────────────────────────────────────────────────

const BASE_API_URL = 'https://api.anthropic.com';

function deriveWorkerName(args: AgentRunArgs): string {
  // claude.ai shows this as the worker label. Keep it short and stable —
  // the first line of systemPrompt is usually the orchestrator / role
  // header which makes a reasonable name. Fall back to a generic label.
  const firstLine = args.systemPrompt.split('\n').find((l) => l.trim().length > 0);
  if (firstLine && firstLine.length > 0) {
    const clean = firstLine.replace(/[#*`]/g, '').trim();
    return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
  }
  return 'pinloom-worker';
}

// Build a log callback that defensively redacts the access token, in case
// the SDK ever surfaces a request URL or header containing it.
function makeRedactingLogger(accessToken: string): (msg: string) => void {
  const needle = accessToken.length > 8 ? accessToken : null;
  return (msg: string) => {
    const safe = needle && msg.includes(needle) ? msg.split(needle).join('[redacted]') : msg;
    // eslint-disable-next-line no-console
    console.log(`[claude-remote] ${safe}`);
  };
}

class ClaudeRemoteAdapterImpl implements AgentAdapter {
  readonly name = 'claude' as const;
  // Remote-control sessions don't carry a pinloom-side resume token —
  // the SDK manages claudeSessionId/SSE seq inside its bridge worker.
  // See AgentAdapter.supportsResume in types.ts for why this matters
  // (runner skips its stale-resume fallback ladder for us).
  readonly supportsResume = false as const;

  run(args: AgentRunArgs): AgentRun {
    const promptStream = new UserPromptStream();
    promptStream.push(args.initialPrompt);

    const eventQueue = new AsyncEventQueue<NormalizedEvent>();
    const convertState: ConvertState = { totalText: '' };

    type WorkerHandleMin = {
      pushPrompt(content: PromptContentBlock[] | string): void;
      teardown(): Promise<void>;
      done: Promise<void>;
    };
    let handle: WorkerHandleMin | undefined;

    function fail(
      kind: 'auth' | 'conflict' | 'network' | 'credential' | 'unknown',
      reason: string,
    ) {
      // eslint-disable-next-line no-console
      console.error(`[claude-remote:${kind}] ${reason}`);
      // Push a typed adapter_error event before closing so the runner
      // can persist it as a system message (role: 'system'), keeping
      // it out of the assistant transcript the next turn would
      // otherwise read back as context.
      //
      // Deliberately DO NOT call `args.abortController.abort()` here —
      // that signal is reserved for user-initiated cancel, and the
      // runner uses it to decide whether to write a "[cancelled by
      // user]" row. An adapter-level failure should look like an
      // error, not a cancellation. If the bridge worker is up, tear
      // it down so its internal wait can resolve.
      eventQueue.push({ type: 'adapter_error', kind, detail: reason });
      if (handle) {
        void handle.teardown().catch(() => {
          // best-effort
        });
      }
      eventQueue.close();
    }

    async function setup() {
      let credentials: { accessToken: string; orgUUID: string };
      try {
        credentials = loadRemoteCredentials();
      } catch (err) {
        const detail =
          err instanceof CredentialError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        fail('credential', detail);
        return;
      }

      // Honor an abort that landed between adapter.run() returning and
      // setup() reaching here — otherwise we'd kick off a bridge connect
      // we already promised to skip.
      if (args.abortController.signal.aborted) {
        eventQueue.close();
        return;
      }

      // Persist worker state per pinloom session so backend restart
      // resumes the same bridge worker instead of spawning a new one
      // on claude.ai. `sessionId` is optional on AgentRunArgs but the
      // remote adapter only makes sense with one — fall back to a
      // stateless adapter if a caller ever omits it (test harnesses
      // do, today).
      const stateAdapter = args.sessionId
        ? createWorkerStateAdapter(args.sessionId)
        : undefined;

      const result = await runAssistantWorker({
        bridge: {
          dir: args.cwd,
          // Re-resolve through the cache rather than capturing the
          // initial value — `onAuth401` calls `invalidateRemoteCredentials`,
          // and the SDK's automatic retry needs the *next* getAccessToken
          // call to return a fresh token. Closing over `credentials`
          // would feed the same stale string back on retry.
          getAccessToken: () => loadRemoteCredentials().accessToken,
          baseUrl: BASE_API_URL,
          orgUUID: credentials.orgUUID,
          model: args.model ?? 'claude-sonnet-4-5',
          name: deriveWorkerName(args),
          // perpetual=true tells the SDK to reuse the env+session
          // recorded in bridge-pointer.json across restarts. Combined
          // with our stateAdapter (which mirrors the SDK's WorkerState
          // into SQLite), a backend restart lands on the same
          // claude.ai worker the user was already chatting with.
          perpetual: true,
          // Token rotated since we last cached it — drop the cache and
          // let the next bridge connect re-read from keychain (Claude
          // Code refreshes it in the background). Return true to tell
          // the SDK to retry with the new token.
          onAuth401: async () => {
            invalidateRemoteCredentials();
            return true;
          },
          // claude.ai detected another machine already holding this
          // env+session. Abort with a typed error rather than silently
          // stealing — the user can resolve manually (sign out
          // elsewhere, or rename / recreate the session). Also push
          // the machine name through `adapter_error` so the user can
          // see WHICH other machine; otherwise `onConflict` provides
          // no UI signal and the whole callback is wasted.
          onConflict: async (detail) => {
            eventQueue.push({
              type: 'adapter_error',
              kind: 'conflict',
              detail: `another machine "${detail.machineName}" already holds this session: ${detail.message}`,
            });
            return 'abort';
          },
        },
        // SDK accepts undefined as "run stateless" — no need for a
        // conditional spread.
        stateAdapter,
        // Spread `base` so the SDK-injected canUseTool survives, then
        // layer the pinloom-side options that match the local adapter.
        // `cwd` is set explicitly (not just via bridge.dir) so tool
        // execution lands in the project directory even if the SDK ever
        // changes how it derives cwd from bridge config.
        buildQueryOptions: (base) => {
          const options: Record<string, unknown> = {
            ...(base as unknown as Record<string, unknown>),
            cwd: args.cwd,
            systemPrompt: args.systemPrompt,
            permissionMode: 'bypassPermissions',
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(command:*)'],
            settingSources: ['user', 'project'],
            includePartialMessages: true,
            thinking: { type: 'adaptive' },
          };
          if (args.mcpServers) options.mcpServers = args.mcpServers;
          if (args.model) options.model = args.model;
          // PR 2 will wire WorkerStateAdapter so the SDK can resume
          // its own claudeSessionId across backend restarts; for PR 1
          // every restart starts a fresh bridge session.
          return options as Parameters<typeof runAssistantWorker>[0]['buildQueryOptions'] extends (
            base: infer _B,
          ) => infer R | Promise<infer R>
            ? R
            : never;
        },
        transformOutbound: (msg) => {
          for (const ev of convertSdkMessage(msg, convertState)) {
            eventQueue.push(ev);
          }
          return msg;
        },
        signal: args.abortController.signal,
        log: makeRedactingLogger(credentials.accessToken),
      });

      if (!result.ok) {
        // SDK error kinds map 1:1 to our adapter_error kinds; cast the
        // discriminant after a narrow whitelist check so a future SDK
        // addition doesn't silently fall through as 'unknown' details.
        const kind: 'auth' | 'conflict' | 'network' | 'unknown' =
          result.error.kind === 'auth'
            ? 'auth'
            : result.error.kind === 'conflict'
              ? 'conflict'
              : result.error.kind === 'network'
                ? 'network'
                : 'unknown';
        fail(kind, result.error.detail);
        return;
      }

      handle = result.handle as unknown as WorkerHandleMin;

      try {
        for await (const p of promptStream) {
          const content = buildContentBlocks(p.text, p.images);
          handle.pushPrompt(content);
        }
        // promptStream exhausted (runner called close()) — explicitly tear
        // down the bridge so handle.done resolves. Without this the await
        // below hangs forever and the run leaks.
        await handle.teardown().catch(() => {
          // best-effort
        });
        await handle.done;
      } finally {
        eventQueue.close();
      }
    }

    setup().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail('unknown', `setup error: ${detail}`);
    });

    return {
      events: eventQueue.iterator(),
      pushMessage(prompt: UserPrompt) {
        promptStream.push(prompt);
      },
      close() {
        // Abort propagates into the SDK's signal — if connect is still
        // in flight, the SDK rejects with an abort error, fail() runs,
        // and the queue closes. If connect already succeeded, handle
        // teardown finishes the wind-down.
        args.abortController.abort();
        promptStream.close();
        if (handle) {
          void handle.teardown().catch(() => {
            // best-effort
          });
        }
      },
    };
  }
}

export const claudeRemoteAdapter: AgentAdapter = new ClaudeRemoteAdapterImpl();
