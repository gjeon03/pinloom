import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import type { Message, MessageRole } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';

interface PersistArgs {
  sessionId: string;
  planItemId: string | null;
  role: MessageRole;
  content: string;
  toolUse?: unknown;
}

interface SessionContext {
  id: string;
  projectId: string;
  planId: string | null;
  claudeSessionId: string | null;
  cwd: string;
}

interface PlanItemLite {
  id: string;
  title: string;
  status: string;
}

function summarizeToolCall(block: { name?: string; input?: unknown }): string {
  const name = block.name ?? 'tool';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return name;
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

const SYSTEM_PROMPT = `You are the AI assistant embedded in pinloom, a plan-first local coding workspace.

Rules:
- You are scoped to ONE project on disk (cwd is set for you). Operate on files there.
- The user is iterating on a living plan. Prefer incremental changes over rewrites.
- If the user references a plan item (by title or by @id), ground your response in that item.
- Be concise. Show code blocks only when useful. Use Korean if the user writes in Korean.`;

function persistMessage(args: PersistArgs): Message {
  const db = getDb();
  const id = nanoid();
  const now = new Date().toISOString();
  const toolUseJson = args.toolUse ? JSON.stringify(args.toolUse) : null;

  db.prepare(
    `INSERT INTO messages
       (id, session_id, plan_item_id, role, content, tool_use, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, args.sessionId, args.planItemId, args.role, args.content, toolUseJson, now);

  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, args.sessionId);

  const message: Message = {
    id,
    sessionId: args.sessionId,
    planItemId: args.planItemId,
    role: args.role,
    content: args.content,
    toolUse: toolUseJson,
    pinned: false,
    pinTitle: null,
    sourceMessageId: null,
    createdAt: now,
  };
  broadcast(`session:${args.sessionId}`, { type: 'message', sessionId: args.sessionId, message });
  return message;
}

function loadSession(sessionId: string): SessionContext | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id, s.project_id, s.plan_id, s.claude_session_id, p.cwd
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        project_id: string;
        plan_id: string | null;
        claude_session_id: string | null;
        cwd: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    claudeSessionId: row.claude_session_id,
    cwd: row.cwd,
  };
}

function loadPlanItems(planId: string | null): PlanItemLite[] {
  if (!planId) return [];
  const db = getDb();
  return db
    .prepare(
      'SELECT id, title, status FROM plan_items WHERE plan_id = ? ORDER BY order_index ASC',
    )
    .all(planId) as PlanItemLite[];
}

function buildPlanContext(items: PlanItemLite[]): string {
  if (items.length === 0) return '';
  const lines = items.map((i) => `- [${i.status}] (${i.id}) ${i.title}`);
  return `\n\n## Current plan items\n${lines.join('\n')}\n\nReference by @<id> if you want to tie a change to a specific item.`;
}

interface PinRow {
  id: string;
  pin_title: string | null;
  content: string;
}

function buildPinsContext(sessionId: string): string {
  const db = getDb();
  const pins = db
    .prepare(
      `SELECT id, pin_title, content
       FROM messages
       WHERE session_id = ? AND pinned = 1
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as PinRow[];
  if (pins.length === 0) return '';

  const blocks = pins.map((p) => {
    const heading = p.pin_title?.trim() || '(untitled pin)';
    return `### ${heading}\n\n${p.content.trim()}`;
  });

  return [
    '## Pinned notes',
    '',
    'The user has pinned the following notes to this session. Treat them as authoritative context you already agreed on. They persist across turns.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function updateClaudeSessionId(sessionId: string, claudeSessionId: string) {
  const db = getDb();
  db.prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?').run(
    claudeSessionId,
    new Date().toISOString(),
    sessionId,
  );
}

function clearClaudeSessionId(sessionId: string) {
  const db = getDb();
  db.prepare('UPDATE sessions SET claude_session_id = NULL, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    sessionId,
  );
}

interface HistoryMessage {
  role: string;
  content: string;
  created_at: string;
}

function loadRecentHistory(sessionId: string, excludeId: string, limit = 40): HistoryMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content, created_at
       FROM messages
       WHERE session_id = ? AND id != ? AND role IN ('user', 'assistant')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(sessionId, excludeId, limit) as HistoryMessage[];
  return rows.reverse();
}

function buildFallbackPrompt(history: HistoryMessage[], currentUserMessage: string): string {
  if (history.length === 0) return currentUserMessage;
  const lines: string[] = [
    '## Prior conversation (reconstructed from local history)',
    '',
  ];
  for (const h of history) {
    const label = h.role === 'assistant' ? 'You (AI)' : 'Human';
    lines.push(`**${label}**: ${h.content}`);
    lines.push('');
  }
  lines.push('## New message');
  lines.push('');
  lines.push(`**Human**: ${currentUserMessage}`);
  lines.push('');
  lines.push('Continue the conversation.');
  return lines.join('\n');
}

interface AssistantStream {
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
}

const MENTION_PATTERN = /@([A-Za-z0-9_-]{10,})/g;

export function extractMentions(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(MENTION_PATTERN)) {
    ids.push(match[1]);
  }
  return ids;
}

function resolveMentionedItem(
  content: string,
  planItems: PlanItemLite[],
): string | null {
  if (planItems.length === 0) return null;
  const valid = new Set(planItems.map((i) => i.id));
  for (const id of extractMentions(content)) {
    if (valid.has(id)) return id;
  }
  return null;
}

export async function sendUserMessage(
  sessionId: string,
  content: string,
  planItemId: string | null = null,
): Promise<Message> {
  const ctx = loadSession(sessionId);
  if (!ctx) throw new Error(`session ${sessionId} not found`);

  const planItems = loadPlanItems(ctx.planId);
  const resolvedPlanItemId = planItemId ?? resolveMentionedItem(content, planItems);

  const userMsg = persistMessage({
    sessionId,
    planItemId: resolvedPlanItemId,
    role: 'user',
    content,
  });

  runAssistant(ctx, content, resolvedPlanItemId, planItems).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    persistMessage({
      sessionId,
      planItemId: resolvedPlanItemId,
      role: 'system',
      content: `[runner error] ${message}`,
    });
    broadcast(`session:${sessionId}`, {
      type: 'run_status',
      sessionId,
      status: 'error',
      error: message,
    });
  });

  return userMsg;
}

async function runAttempt(
  ctx: SessionContext,
  prompt: string,
  planItemId: string | null,
  systemPrompt: string,
  useResume: boolean,
): Promise<string> {
  const options: Record<string, unknown> = {
    cwd: ctx.cwd,
    systemPrompt,
    maxTurns: 20,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(command:*)'],
  };
  if (useResume && ctx.claudeSessionId) {
    options.resume = ctx.claudeSessionId;
  }

  const q = query({
    prompt,
    options: options as Parameters<typeof query>[0]['options'],
  });

  let finalText = '';

  for await (const message of q) {
    if (message.type === 'assistant') {
      const msg = message as AssistantStream;
      if (msg.session_id && msg.session_id !== ctx.claudeSessionId) {
        updateClaudeSessionId(ctx.id, msg.session_id);
        ctx.claudeSessionId = msg.session_id;
      }
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          finalText += block.text;
        } else if (block.type === 'tool_use') {
          persistMessage({
            sessionId: ctx.id,
            planItemId,
            role: 'tool',
            content: summarizeToolCall(block),
            toolUse: { name: block.name, input: block.input },
          });
          broadcast(`session:${ctx.id}`, {
            type: 'run_log',
            sessionId: ctx.id,
            stream: 'stdout',
            chunk: `$ ${summarizeToolCall(block)}\n`,
          });
        }
      }
    } else if (message.type === 'user') {
      const msg = message as {
        message?: {
          content?: Array<{
            type: string;
            content?: unknown;
            is_error?: boolean;
          }>;
        };
      };
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content);
          if (text) {
            broadcast(`session:${ctx.id}`, {
              type: 'run_log',
              sessionId: ctx.id,
              stream: block.is_error ? 'stderr' : 'stdout',
              chunk: text.endsWith('\n') ? text : `${text}\n`,
            });
          }
        }
      }
    } else if (message.type === 'result') {
      const result = message as { subtype?: string; result?: string; session_id?: string };
      if (result.session_id && result.session_id !== ctx.claudeSessionId) {
        updateClaudeSessionId(ctx.id, result.session_id);
      }
      if (result.subtype === 'success' && result.result && result.result.length > finalText.length) {
        finalText = result.result;
      }
    }
  }

  return finalText;
}

async function runAssistant(
  ctx: SessionContext,
  prompt: string,
  planItemId: string | null,
  planItems: PlanItemLite[],
): Promise<void> {
  broadcast(`session:${ctx.id}`, { type: 'run_status', sessionId: ctx.id, status: 'started' });

  const pinsContext = buildPinsContext(ctx.id);
  const systemPrompt =
    SYSTEM_PROMPT + buildPlanContext(planItems) + (pinsContext ? `\n\n${pinsContext}` : '');

  try {
    let finalText = '';

    if (ctx.claudeSessionId) {
      try {
        finalText = await runAttempt(ctx, prompt, planItemId, systemPrompt, true);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast(`session:${ctx.id}`, {
          type: 'run_log',
          sessionId: ctx.id,
          stream: 'stderr',
          chunk: `[resume failed, rebuilding context from local history] ${errMsg}\n`,
        });
        clearClaudeSessionId(ctx.id);
        ctx.claudeSessionId = null;
      }
    }

    if (!ctx.claudeSessionId) {
      const userMsgRow = getDb()
        .prepare(
          'SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(ctx.id, 'user') as { id: string } | undefined;
      const history = loadRecentHistory(ctx.id, userMsgRow?.id ?? '');
      const fallbackPrompt =
        history.length > 0 ? buildFallbackPrompt(history, prompt) : prompt;
      finalText = await runAttempt(
        ctx,
        fallbackPrompt,
        planItemId,
        systemPrompt,
        false,
      );
    }

    if (finalText.trim().length > 0) {
      persistMessage({
        sessionId: ctx.id,
        planItemId,
        role: 'assistant',
        content: finalText,
      });
    }

    broadcast(`session:${ctx.id}`, {
      type: 'run_status',
      sessionId: ctx.id,
      status: 'finished',
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    persistMessage({
      sessionId: ctx.id,
      planItemId,
      role: 'system',
      content: `[runner error] ${errorMsg}`,
    });
    broadcast(`session:${ctx.id}`, {
      type: 'run_status',
      sessionId: ctx.id,
      status: 'error',
      error: errorMsg,
    });
  }
}
