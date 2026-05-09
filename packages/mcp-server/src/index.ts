#!/usr/bin/env node
// pinloom MCP server — gives an orchestrator agent five tools for
// dispatching work to its team's worker sessions by alias. The server is
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
  'team_send',
  {
    description:
      "Send a prompt to a worker session by alias. Enqueues the message; the worker's runner will pick it up at the next turn boundary. Returns immediately — use team_wait to block until the worker is idle.",
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
      text: z.string().describe('Prompt text to send'),
    },
  },
  async (args) => {
    await call('POST', teamUrl('/send'), {
      alias: args.alias,
      text: args.text,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Enqueued ${args.text.length} chars to @${args.alias}.`,
        },
      ],
    };
  },
);

server.registerTool(
  'team_read',
  {
    description:
      "Read messages from a worker. Default: most recent N messages (chronological order). Pass sinceMessageId to instead get messages newer than that id (forward pagination). Returns user + assistant messages only.",
    inputSchema: {
      alias: z.string().describe('Worker alias (without leading @)'),
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
    const status = await call<{ running: boolean; queued: number }>(
      'GET',
      teamUrl(`/status?${params.toString()}`),
    );
    return {
      content: [
        {
          type: 'text',
          text: `@${args.alias}: ${
            status.running ? 'running' : 'idle'
          }, ${status.queued} queued`,
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
    const result = await call<{ idle: boolean; queued: number }>(
      'GET',
      teamUrl(`/wait?${params.toString()}`),
    );
    return {
      content: [
        {
          type: 'text',
          text: result.idle
            ? `@${args.alias} is now idle (queued=${result.queued}).`
            : `@${args.alias} did not become idle within the timeout (queued=${result.queued}).`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
