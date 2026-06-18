#!/usr/bin/env node
// pinloom MCP server — gives an orchestrator agent nine tools for
// driving its team. Eight dispatch / inspection tools (list, send,
// send_tag, ask, ask_tag, read, status, wait) plus one mutation tool
// (update_member) so the orchestrator can sharpen a worker's role
// mid-session without breaking out to the UI.
//
// `team_ask` / `team_ask_tag` mirror the Claude Agent SDK's Task
// tool — they block the orchestrator's tool-call until the worker(s)
// reply, and return the reply directly as the tool_result. That keeps
// the orchestrator's turn alive across the whole round trip and is
// almost always what you want when delegating focused work. Use the
// asynchronous `team_send` / `team_send_tag` only when you genuinely
// want fire-and-forget (e.g. kicking off a long task and continuing
// other work in the same turn). The server is
// a thin stdio shim: every tool call translates into an HTTP request
// against pinloom's backend (default http://localhost:4748). Identity
// arrives via three env vars injected by the runner at spawn time:
//
//   PINLOOM_TEAM_ID     — which team this orchestrator belongs to
//   PINLOOM_TEAM_TOKEN  — single-use rotation token issued per session
//   PINLOOM_BACKEND_URL — override for the backend base URL
//
// The token guards against stale/orphan MCP shims continuing to dispatch
// after the backend has reaped their team. It is *not* a security
// boundary against another local user — this is a single-user app.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TEAM_ID = process.env.PINLOOM_TEAM_ID;
const TEAM_TOKEN = process.env.PINLOOM_TEAM_TOKEN;
const BACKEND_URL =
  process.env.PINLOOM_BACKEND_URL?.replace(/\/$/, '') ?? 'http://localhost:4748';

if (!TEAM_ID || !TEAM_TOKEN) {
  // eslint-disable-next-line no-console
  console.error(
    '[pinloom-mcp] missing PINLOOM_TEAM_ID or PINLOOM_TEAM_TOKEN — shim cannot start',
  );
  process.exit(1);
}

interface ApiError {
  error: string;
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    'X-Pinloom-Team-Token': TEAM_TOKEN!,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as ApiError).error
        : text || res.statusText;
    throw new Error(`pinloom backend ${res.status}: ${detail}`);
  }
  return parsed as T;
}

function teamUrl(suffix: string): string {
  return `/api/teams/${encodeURIComponent(TEAM_ID!)}/dispatch${suffix}`;
}

interface MemberStatus {
  alias: string;
  agent: 'claude' | 'codex';
  lastModel: string | null;
  projectName: string | null;
  status: 'idle' | 'running' | 'queued' | 'mixed';
  queued: number;
}

interface WorkerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

interface MemberSpec {
  alias: string;
  instructions: string | null;
  tags: string[];
}

interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  cwd: string;
  sessionCount: number;
}

interface CreatedWorker {
  sessionId: string;
  alias: string;
  instructions: string | null;
  tags: string[];
  projectId: string;
  projectName: string;
  transport: string | null;
  agent: 'claude' | 'codex';
}

const server = new McpServer({
  name: 'pinloom',
  version: '0.0.1',
});

server.registerTool(
  'team_list',
  {
    description:
      'List worker sessions in this team with their current status. Returns one entry per worker (alias, agent, model, project, status, queued count).',
    inputSchema: {},
  },
  async () => {
    const members = await call<MemberStatus[]>('GET', teamUrl('/list'));
    if (members.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No workers in this team yet. Add workers via the Teams page.',
          },
        ],
      };
    }
    const lines = members.map(
      (m) =>
        `@${m.alias}\t${m.agent}${m.lastModel ? `:${m.lastModel}` : ''}\tproject=${
          m.projectName ?? '?'
        }\tstatus=${m.status}\tqueued=${m.queued}`,
    );
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

server.registerTool(
  'team_list_projects',
  {
    description:
      'List the projects you can place a worker in (slug, name, cwd, session count). Call this before team_create_worker when you want a worker in a DIFFERENT project than your own — teams exist for cross-project collaboration, so pick the target project by its slug.',
    inputSchema: {},
  },
  async () => {
    const projects = await call<ProjectInfo[]>('GET', teamUrl('/projects'));
    if (projects.length === 0) {
      return { content: [{ type: 'text', text: 'No projects.' }] };
    }
    const lines = projects.map(
      (p) => `${p.slug}\t${p.name}\t${p.cwd}\t(${p.sessionCount} sessions)`,
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.registerTool(
  'team_create_worker',
  {
    description:
      "Create a NEW worker session in this team, give it a persona, then collaborate via team_ask. Use this to spin up a teammate on demand (e.g. the user says \"make a security-review worker and work with it\"). `instructions` is the worker's persona / system-prompt — its identity, do's & don'ts, and output conventions; craft a sharp one (≤ 4000 chars). `project` places the worker in ANOTHER project by slug/name/id — teams are for cross-project work, so put e.g. a backend collaborator in the backend project (call team_list_projects first to get slugs); omit it to use your own project. The new worker is a real, visible session the user can open and talk to directly. After it's created, call team_ask(alias, …) to start working together. (To refine an EXISTING worker's persona instead, use team_update_member.)",
    inputSchema: {
      alias: z
        .string()
        .describe('Worker alias — lowercase, no leading @ (e.g. "sec", "be").'),
      instructions: z
        .string()
        .describe("The worker's persona / system-prompt guidance (≤ 4000 chars)."),
      project: z
        .string()
        .optional()
        .describe(
          'Target project by slug, name, or id. Omit for your own project. Use team_list_projects to discover slugs.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe('Optional lowercase tags for broadcast grouping (team_ask_tag / team_send_tag).'),
      agent: z
        .enum(['claude', 'codex'])
        .optional()
        .describe('Worker agent; defaults to claude.'),
    },
  },
  async (args) => {
    const body: Record<string, unknown> = {
      alias: args.alias,
      instructions: args.instructions,
    };
    if (args.project !== undefined) body.project = args.project;
    if (args.tags !== undefined) body.tags = args.tags;
    if (args.agent !== undefined) body.agent = args.agent;

    const result = await call<{ ok: true; worker: CreatedWorker }>(
      'POST',
      teamUrl('/create-worker'),
      body,
    );
    const w = result.worker;
    const lines = [
      `Created worker @${w.alias} (${w.agent}) in project "${w.projectName}".`,
      `Persona set (${w.instructions ? w.instructions.length : 0} chars)${
        w.tags.length > 0 ? `, tags: ${w.tags.map((t) => `#${t}`).join(' ')}` : ''
      }.`,
      `Now call team_ask("${w.alias}", …) to collaborate; the user can also open this worker's session directly.`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.registerTool(
  'team_send',
  {
    description:
      "Send a prompt to a worker session by alias. Enqueues the message; the worker's runner will pick it up at the next turn boundary. Returns immediately with a dispatchId handle — use team_wait/team_status, or team_read(dispatchId) to fetch the reply once it's done. Best for kicking off a long task without blocking your turn.",
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
      text: z.string().describe('Prompt text to send'),
    },
  },
  async (args) => {
    const r = await call<{ dispatchId?: string }>('POST', teamUrl('/send'), {
      alias: args.alias,
      text: args.text,
    });
    const handle = r.dispatchId
      ? ` Dispatch ${r.dispatchId} — reconnect later with team_status / team_wait / team_read(dispatchId).`
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `Enqueued ${args.text.length} chars to @${args.alias}.${handle}`,
        },
      ],
    };
  },
);

server.registerTool(
  'team_send_tag',
  {
    description:
      "Broadcast the same prompt to every worker tagged with `tag`. Equivalent to calling team_send for each matching alias, but in one round trip. Returns the list of recipients (their aliases) plus any failures. There is no team_wait_tag — to synchronize on the whole fanout, iterate `team_wait` over each returned alias. Use this when you have a question for everyone in a category (e.g. 'review this PR', 'estimate this'); use team_send when only one worker is the right pick.",
    inputSchema: {
      tag: z.string().describe('Tag to broadcast to (without leading #)'),
      text: z.string().describe('Prompt text to send'),
    },
  },
  async (args) => {
    const result = await call<{
      recipients: Array<{ alias: string; sessionId: string }>;
      failures: Array<{ alias: string; error: string }>;
    }>('POST', teamUrl('/send-tag'), {
      tag: args.tag,
      text: args.text,
    });
    // Lead with whichever signal is most actionable. When everything
    // failed, surface the failures first so the orchestrator doesn't
    // skim past them and assume the broadcast succeeded.
    const recipientLine =
      result.recipients.length > 0
        ? `Enqueued ${args.text.length} chars to ${result.recipients.length} worker(s) tagged #${args.tag}: ${result.recipients
            .map((r) => `@${r.alias}`)
            .join(', ')}.`
        : null;
    const failureLine =
      result.failures.length > 0
        ? `Failures (${result.failures.length}): ${result.failures
            .map((f) => `@${f.alias} (${f.error})`)
            .join(', ')}`
        : null;
    if (!recipientLine && !failureLine) {
      return {
        content: [
          {
            type: 'text',
            text: `No workers tagged #${args.tag} in this team. Either add the tag to the workers you want, or call team_send by alias.`,
          },
        ],
      };
    }
    // Failures-first when the call was a total wash; recipients-first
    // for partial fanout so the success info isn't buried.
    const text =
      recipientLine === null
        ? failureLine!
        : failureLine === null
          ? recipientLine
          : `${recipientLine}\n${failureLine}`;
    return {
      content: [{ type: 'text', text }],
    };
  },
);

server.registerTool(
  'team_ask',
  {
    description:
      "Send a prompt to a worker and BLOCK until the worker has produced a reply. Returns the worker's final assistant message directly as the tool_result, mirroring the Claude SDK's Task tool. This is the default delegation pattern — your turn stays alive across the whole round trip, and you can chain follow-up tool calls (or call team_ask on another worker, in parallel) without ending your turn. Default + max wait is 5min; if the worker doesn't finish in time the call returns idle=false and you can decide to retry, fall back to team_status, or report progress to the user. Prefer this over team_send unless you specifically need fire-and-forget.",
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
      text: z.string().describe('Prompt text to send'),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe(
          'Max wait in ms (default 300000, capped at 300000). Returns the moment the worker idles.',
        ),
    },
  },
  async (args) => {
    type Reply = {
      ok: boolean;
      idle: boolean;
      alias: string;
      sessionId: string;
      dispatchId?: string;
      state?: string;
      error?: string;
      message: { id: string; content: string; createdAt: string } | null;
    };
    const params: Record<string, unknown> = {
      alias: args.alias,
      text: args.text,
    };
    if (args.timeoutMs !== undefined) params.timeoutMs = args.timeoutMs;
    const r = await call<Reply>('POST', teamUrl('/ask'), params);
    if (!r.idle) {
      // Not a hard failure: the dispatch keeps running. Hand back the handle so
      // the orchestrator can reconnect instead of losing the work to the wall.
      const handle = r.dispatchId ? ` (dispatchId ${r.dispatchId})` : '';
      if (r.state === 'failed' || r.error) {
        return {
          content: [
            {
              type: 'text',
              text: `@${args.alias} dispatch failed${handle}: ${r.error ?? 'unknown error'}.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `@${args.alias} is still running${handle}. The dispatch keeps going past this wait — reconnect with team_wait, or team_read(dispatchId) once it's done.`,
          },
        ],
      };
    }
    if (!r.message) {
      return {
        content: [
          {
            type: 'text',
            text: `@${args.alias} idled but produced no assistant message in this turn (tool calls only?). Call team_read to inspect.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `--- @${args.alias} reply (${r.message.id}) at ${r.message.createdAt} ---\n${r.message.content}`,
        },
      ],
    };
  },
);

server.registerTool(
  'team_ask_tag',
  {
    description:
      "Broadcast variant of team_ask. Sends the same prompt to every worker tagged with `tag` and BLOCKS until every recipient has either replied or hit the timeout. Returns each reply concatenated — one block per recipient, plus a summary line listing any timeouts/failures. All workers are waited on in parallel, so total wall time is roughly the slowest worker, not the sum. Default + max wait is 5min per worker.",
    inputSchema: {
      tag: z.string().describe('Tag to broadcast to (without leading #)'),
      text: z.string().describe('Prompt text to send'),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe('Per-worker max wait in ms (default 300000, capped 300000).'),
    },
  },
  async (args) => {
    type AskTagReply = {
      ok: boolean;
      replies: Array<{
        alias: string;
        sessionId: string;
        message: { id: string; content: string; createdAt: string } | null;
      }>;
      failures: Array<{ alias: string; error: string }>;
      timedOut: Array<{ alias: string; sessionId: string }>;
    };
    const params: Record<string, unknown> = {
      tag: args.tag,
      text: args.text,
    };
    if (args.timeoutMs !== undefined) params.timeoutMs = args.timeoutMs;
    const r = await call<AskTagReply>('POST', teamUrl('/ask-tag'), params);
    if (
      r.replies.length === 0 &&
      r.failures.length === 0 &&
      r.timedOut.length === 0
    ) {
      return {
        content: [
          {
            type: 'text',
            text: `No workers tagged #${args.tag} in this team. Either add the tag to the workers you want, or use team_ask by alias.`,
          },
        ],
      };
    }
    const replyBlocks = r.replies.map((rep) => {
      if (!rep.message) {
        return `--- @${rep.alias}: idled but no assistant message ---`;
      }
      return `--- @${rep.alias} reply (${rep.message.id}) at ${rep.message.createdAt} ---\n${rep.message.content}`;
    });
    const tail: string[] = [];
    if (r.timedOut.length > 0) {
      tail.push(
        `Timed out (${r.timedOut.length}): ${r.timedOut
          .map((t) => `@${t.alias}`)
          .join(', ')} — still queued, retriable via team_read later.`,
      );
    }
    if (r.failures.length > 0) {
      tail.push(
        `Failures (${r.failures.length}): ${r.failures
          .map((f) => `@${f.alias} (${f.error})`)
          .join(', ')}`,
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: [...replyBlocks, ...tail].join('\n\n'),
        },
      ],
    };
  },
);

server.registerTool(
  'team_update_member',
  {
    description:
      "Update a worker's instructions, tags, or alias mid-session. Use this when the conversation reveals a sharper role for an existing worker (e.g. you discover @be1 is also the right person for security review and want to add the #security tag). Partial-update semantics: omit a field to leave it unchanged; pass `instructions: null` or `tags: []` to clear (an empty string for `instructions` is rejected — use `null`). To rename, set `newAlias` — the old alias stops working in subsequent team_send/team_read calls. Takes effect on the worker's NEXT turn — an in-flight turn finishes with its old instructions, so if you've just sent a message, the next reply may still reflect the old role. Cannot add or remove workers — those flow through the user-facing UI to avoid surprise side effects.",
    inputSchema: {
      alias: z
        .string()
        .describe('Current worker alias (without leading @)'),
      newAlias: z
        .string()
        .optional()
        .describe(
          'Optional rename. Must match /^[a-z][a-z0-9_-]{0,31}$/ and not collide with another worker in this team.',
        ),
      instructions: z
        .string()
        .nullable()
        .optional()
        .describe(
          "System-prompt-style guidance injected into the worker's prompt every turn. Pass null to clear; omit to leave unchanged. Cap 4000 chars.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'Replace the full tag list. Pass [] to clear; omit to leave unchanged. Each tag must match /^[a-z][a-z0-9_-]{0,31}$/. Cap 16 tags.',
        ),
    },
  },
  async (args) => {
    const body: Record<string, unknown> = { alias: args.alias };
    // Forward only the fields the caller actually set so the route's
    // 'key in body' presence check sees the same shape.
    if (args.newAlias !== undefined) body.newAlias = args.newAlias;
    if (args.instructions !== undefined) body.instructions = args.instructions;
    if (args.tags !== undefined) body.tags = args.tags;
    const result = await call<{ ok: true; member: MemberSpec }>(
      'POST',
      teamUrl('/update-member'),
      body,
    );
    const m = result.member;
    const lines = [`Updated @${m.alias}.`];
    if (args.newAlias !== undefined && args.newAlias !== args.alias) {
      lines.push(
        `  Renamed from @${args.alias} — use @${m.alias} in future calls.`,
      );
    }
    if (args.instructions !== undefined) {
      lines.push(
        m.instructions
          ? `  Instructions: ${m.instructions.length} chars set.`
          : '  Instructions cleared.',
      );
    }
    if (args.tags !== undefined) {
      lines.push(
        m.tags.length > 0
          ? `  Tags: ${m.tags.map((t) => `#${t}`).join(' ')}`
          : '  Tags cleared.',
      );
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.registerTool(
  'team_read',
  {
    description:
      "Read a worker's output. Pass dispatchId to get that specific dispatch's final reply straight from its record — race-free (it never depends on the async transcript capture landing). Otherwise pass alias for recent chat: most recent N messages (chronological), or messages newer than sinceMessageId. Returns user + assistant messages only.",
    inputSchema: {
      alias: z
        .string()
        .optional()
        .describe('Worker alias (without leading @). Required unless dispatchId is set.'),
      dispatchId: z
        .string()
        .optional()
        .describe(
          'If set, return that dispatch\'s recorded reply directly (the handle from team_send/team_ask). Race-free; ignores alias/sinceMessageId/limit.',
        ),
      sinceMessageId: z
        .string()
        .optional()
        .describe(
          'If set, return only messages strictly newer than this id (chronological forward).',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Max number of messages to return (default 20). When sinceMessageId is unset, this is "latest N".',
        ),
    },
  },
  async (args) => {
    // dispatchId form: the record reply, shaped as { dispatch, messages }.
    if (args.dispatchId) {
      const params = new URLSearchParams({ dispatchId: args.dispatchId });
      const r = await call<{
        dispatch: { dispatchId: string; state: string; error: string | null };
        messages: WorkerMessage[];
      }>('GET', teamUrl(`/messages?${params.toString()}`));
      if (r.messages.length === 0) {
        const tail = r.dispatch.error ? ` (${r.dispatch.error})` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Dispatch ${r.dispatch.dispatchId} is ${r.dispatch.state} with no reply yet${tail}.`,
            },
          ],
        };
      }
      const formatted = r.messages
        .map((m) => `--- ${m.role} (${m.id}) at ${m.createdAt} ---\n${m.content}`)
        .join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }
    if (!args.alias) {
      return {
        content: [
          { type: 'text', text: 'team_read needs either alias or dispatchId.' },
        ],
      };
    }
    const params = new URLSearchParams({ alias: args.alias });
    if (args.sinceMessageId) params.set('sinceMessageId', args.sinceMessageId);
    if (args.limit) params.set('limit', String(args.limit));
    const messages = await call<WorkerMessage[]>(
      'GET',
      teamUrl(`/messages?${params.toString()}`),
    );
    if (messages.length === 0) {
      return {
        content: [{ type: 'text', text: '(no new messages)' }],
      };
    }
    const formatted = messages
      .map((m) => `--- ${m.role} (${m.id}) at ${m.createdAt} ---\n${m.content}`)
      .join('\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  },
);

server.registerTool(
  'team_status',
  {
    description:
      'Get a single worker\'s status — whether it\'s currently running, and how many queued messages are pending.',
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
    },
  },
  async (args) => {
    const params = new URLSearchParams({ alias: args.alias });
    const status = await call<{
      running: boolean;
      queued: number;
      dispatch: { dispatchId: string; state: string } | null;
    }>('GET', teamUrl(`/status?${params.toString()}`));
    const dispatchLine = status.dispatch
      ? ` — last dispatch ${status.dispatch.dispatchId} is ${status.dispatch.state}`
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `@${args.alias}: ${
            status.running ? 'running' : 'idle'
          }, ${status.queued} queued${dispatchLine}`,
        },
      ],
    };
  },
);

server.registerTool(
  'team_wait',
  {
    description:
      "Block until a worker becomes idle (i.e. its current run finishes and its queue drains). Returns immediately if already idle. Default and max wait is 5 minutes (300000ms) — long enough for typical reviews/investigations without forcing a polling loop. The server returns early the moment the worker idles.",
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe(
          'Max wait in ms (default 300000, capped at 300000). The wait returns sooner the moment the worker idles.',
        ),
    },
  },
  async (args) => {
    const params = new URLSearchParams({ alias: args.alias });
    if (args.timeoutMs) params.set('timeoutMs', String(args.timeoutMs));
    const result = await call<{
      idle: boolean;
      queued: number;
      dispatch: { dispatchId: string; state: string } | null;
    }>('GET', teamUrl(`/wait?${params.toString()}`));
    const dispatchLine = result.dispatch
      ? ` Dispatch ${result.dispatch.dispatchId}: ${result.dispatch.state}.`
      : '';
    return {
      content: [
        {
          type: 'text',
          text:
            (result.idle
              ? `@${args.alias} is now idle (queued=${result.queued}).`
              : `@${args.alias} did not become idle within the timeout (queued=${result.queued}).`) +
            dispatchLine,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
