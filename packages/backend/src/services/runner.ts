import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import type { Message, MessageRole } from '@planloom/shared';
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

const SYSTEM_PROMPT = `You are the AI assistant embedded in planloom, a plan-first local coding workspace.

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

function updateClaudeSessionId(sessionId: string, claudeSessionId: string) {
  const db = getDb();
  db.prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?').run(
    claudeSessionId,
    new Date().toISOString(),
    sessionId,
  );
}

interface AssistantStream {
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
}

export async function sendUserMessage(
  sessionId: string,
  content: string,
  planItemId: string | null = null,
): Promise<Message> {
  const ctx = loadSession(sessionId);
  if (!ctx) throw new Error(`session ${sessionId} not found`);

  const userMsg = persistMessage({
    sessionId,
    planItemId,
    role: 'user',
    content,
  });

  runAssistant(ctx, content, planItemId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    persistMessage({
      sessionId,
      planItemId,
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

async function runAssistant(
  ctx: SessionContext,
  prompt: string,
  planItemId: string | null,
): Promise<void> {
  broadcast(`session:${ctx.id}`, { type: 'run_status', sessionId: ctx.id, status: 'started' });

  const planItems = loadPlanItems(ctx.planId);
  const systemPrompt = SYSTEM_PROMPT + buildPlanContext(planItems);

  const options: Record<string, unknown> = {
    cwd: ctx.cwd,
    systemPrompt,
    maxTurns: 20,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(command:*)'],
  };
  if (ctx.claudeSessionId) {
    options.resume = ctx.claudeSessionId;
  }

  const q = query({
    prompt,
    options: options as Parameters<typeof query>[0]['options'],
  });

  let finalText = '';

  try {
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
              content: `tool: ${block.name ?? 'unknown'}`,
              toolUse: { name: block.name, input: block.input },
            });
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
