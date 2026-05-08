import { nanoid } from 'nanoid';
import type { Message, MessageRole } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { getAgentAdapter } from './agents/index.js';
import { listUserEnvVars } from './user-env.js';
import type { ImageInput, ImageMediaType } from './runner-types.js';

export type { ImageInput, ImageMediaType } from './runner-types.js';

interface PersistArgs {
  sessionId: string;
  planItemId: string | null;
  role: MessageRole;
  content: string;
  toolUse?: unknown;
}

interface MessageRow {
  id: string;
  session_id: string;
  plan_item_id: string | null;
  role: string;
  content: string;
  tool_use: string | null;
  pinned: number;
  pin_title: string | null;
  pinned_at: string | null;
  source_message_id: string | null;
  model: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    planItemId: row.plan_item_id,
    role: row.role as MessageRole,
    content: row.content,
    toolUse: row.tool_use,
    pinned: row.pinned === 1,
    pinTitle: row.pin_title,
    pinnedAt: row.pinned_at,
    sourceMessageId: row.source_message_id,
    model: row.model,
    createdAt: row.created_at,
  };
}

interface SessionContext {
  id: string;
  projectId: string;
  planId: string | null;
  agent: 'claude' | 'codex';
  // Resume token: Claude SDK calls it session_id; Codex calls it thread_id.
  // Same column under the hood (agent_session_id), just a different label.
  claudeSessionId: string | null;
  cwd: string;
}

interface PlanItemLite {
  id: string;
  title: string;
  status: string;
}

export function summarizeToolCall(block: { name?: string; input?: unknown }): string {
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

export function toolResultText(content: unknown): string {
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

function buildWikiContext(projectId: string): string {
  const slug = getProjectWikiSlugByProjectId(projectId);
  return `

## Personal knowledge wiki

The user maintains a wiki at \`~/.pinloom/wiki/\`. Layout:
- \`index.md\` — list of every page with scope/topic tags
- \`pages/\` — flat directory of \`.md\` pages, each with YAML frontmatter

Each page declares its scope via the \`applies_to\` frontmatter field —
an array of pinloom project slugs, or \`[global]\` for cross-project.

**Active project slug: \`${slug}\`**

When prior knowledge might help:
1. Read \`~/.pinloom/wiki/index.md\` to see all pages with scope tags.
2. A page applies if its \`applies_to\` is missing/empty/contains
   \`global\`, OR contains \`${slug}\`.
3. **Pages whose \`applies_to\` excludes \`${slug}\` MUST NOT inform your
   behavior** — even if the topic looks relevant. Different projects
   have different conventions; do not cross-apply rules.
4. Read full content of relevant pages with Read; follow the
   \`related\` frontmatter field for connected pages.
5. Cite the wiki page when you use it.

Use this sparingly — only when prior context might genuinely help.`;
}

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
    pinnedAt: null,
    sourceMessageId: null,
    model: null,
    createdAt: now,
  };
  broadcast(`session:${args.sessionId}`, { type: 'message', sessionId: args.sessionId, message });
  return message;
}

function loadSession(sessionId: string): SessionContext | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id, s.project_id, s.plan_id, s.agent,
              s.agent_session_id, s.claude_session_id, p.cwd
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        project_id: string;
        plan_id: string | null;
        agent: string;
        agent_session_id: string | null;
        claude_session_id: string | null;
        cwd: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    claudeSessionId: row.agent_session_id ?? row.claude_session_id,
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

export function buildPlanContext(items: PlanItemLite[]): string {
  if (items.length === 0) return '';
  const lines = items.map((i) => `- [${i.status}] (${i.id}) ${i.title}`);
  return `\n\n## Current plan items\n${lines.join('\n')}\n\nReference by @<id> if you want to tie a change to a specific item.`;
}

interface PinRow {
  id: string;
  pin_title: string | null;
  content: string;
}

// Lists user-managed env vars (key + description only, never values) so the
// agent knows what's available to it. The values themselves are exposed via
// process.env, which the Bash tool inherits — the agent should reference
// them as $VAR rather than asking the user to paste them in.
function buildEnvVarsContext(): string {
  const vars = listUserEnvVars();
  if (vars.length === 0) return '';
  const lines = vars.map((v) => {
    const desc = v.description?.trim();
    return `- \`${v.key}\`${desc ? ` — ${desc}` : ''}`;
  });
  return [
    '',
    '## Available environment variables',
    '',
    'The user has configured the following variables in pinloom Settings.',
    'They are exposed to your shell as env vars — reference them as `$VAR`',
    'in Bash commands. Never echo, log, or paste raw values into chat or',
    'into files you write.',
    '',
    ...lines,
  ].join('\n');
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
  // Dual-write to both columns until claude_session_id is fully retired.
  db.prepare(
    'UPDATE sessions SET agent_session_id = ?, claude_session_id = ?, updated_at = ? WHERE id = ?',
  ).run(claudeSessionId, claudeSessionId, new Date().toISOString(), sessionId);
}

function clearClaudeSessionId(sessionId: string) {
  const db = getDb();
  db.prepare(
    'UPDATE sessions SET agent_session_id = NULL, claude_session_id = NULL, updated_at = ? WHERE id = ?',
  ).run(new Date().toISOString(), sessionId);
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

const activeAbortControllers = new Map<string, AbortController>();

export function registerRun(sessionId: string): AbortController {
  const prior = activeAbortControllers.get(sessionId);
  if (prior) prior.abort();
  const controller = new AbortController();
  activeAbortControllers.set(sessionId, controller);
  return controller;
}

export function clearRun(sessionId: string, controller: AbortController) {
  if (activeAbortControllers.get(sessionId) === controller) {
    activeAbortControllers.delete(sessionId);
  }
}

export function cancelAiRun(sessionId: string): boolean {
  const controller = activeAbortControllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  activeAbortControllers.delete(sessionId);
  return true;
}

export function isAiRunning(sessionId: string): boolean {
  return activeAbortControllers.has(sessionId);
}

export function buildFallbackPrompt(history: HistoryMessage[], currentUserMessage: string): string {
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
  images: ImageInput[] = [],
  model?: string,
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

  if (images.length > 0) {
    getDb()
      .prepare(
        'UPDATE sessions SET next_image_number = next_image_number + ? WHERE id = ?',
      )
      .run(images.length, sessionId);
  }

  runAssistant(ctx, content, resolvedPlanItemId, planItems, images, model).catch((err) => {
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
  images: ImageInput[],
  planItemId: string | null,
  systemPrompt: string,
  useResume: boolean,
  abortController: AbortController,
  model?: string,
): Promise<string> {
  const adapter = getAgentAdapter(ctx.agent);
  const run = adapter.run({
    cwd: ctx.cwd,
    prompt,
    images,
    systemPrompt,
    model,
    resume: useResume ? ctx.claudeSessionId : null,
    abortController,
  });

  let totalText = '';
  let streamMsgId: string | null = null;
  let streamContent = '';
  let streamModel: string | null = null;

  function closeStream() {
    if (!streamMsgId) return;
    const db = getDb();
    db.prepare(
      'UPDATE messages SET content = ?, model = COALESCE(?, model) WHERE id = ?',
    ).run(streamContent, streamModel, streamMsgId);
    broadcast(`session:${ctx.id}`, {
      type: 'stream_end',
      sessionId: ctx.id,
      messageId: streamMsgId,
    });
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(streamMsgId) as MessageRow;
    broadcast(`session:${ctx.id}`, {
      type: 'message_updated',
      sessionId: ctx.id,
      message: rowToMessage(row),
    });
    streamMsgId = null;
    streamContent = '';
    streamModel = null;
  }

  function ensureStream(): string {
    if (streamMsgId) return streamMsgId;
    const created = persistMessage({
      sessionId: ctx.id,
      planItemId,
      role: 'assistant',
      content: '',
    });
    streamMsgId = created.id;
    streamContent = '';
    return created.id;
  }

  try {
    for await (const ev of run.events) {
      if (abortController.signal.aborted) break;
      switch (ev.type) {
        case 'session_id':
          if (ev.id !== ctx.claudeSessionId) {
            updateClaudeSessionId(ctx.id, ev.id);
            ctx.claudeSessionId = ev.id;
          }
          break;
        case 'text_delta': {
          const id = ensureStream();
          streamContent += ev.text;
          totalText += ev.text;
          broadcast(`session:${ctx.id}`, {
            type: 'stream_chunk',
            sessionId: ctx.id,
            messageId: id,
            chunk: ev.text,
          });
          break;
        }
        case 'thinking_start':
          broadcast(`session:${ctx.id}`, {
            type: 'thinking_start',
            sessionId: ctx.id,
          });
          break;
        case 'thinking_delta':
          broadcast(`session:${ctx.id}`, {
            type: 'thinking_chunk',
            sessionId: ctx.id,
            chunk: ev.text,
          });
          break;
        case 'tool_use': {
          closeStream();
          const summary = ev.summary ?? ev.name;
          persistMessage({
            sessionId: ctx.id,
            planItemId,
            role: 'tool',
            content: summary,
            toolUse: { name: ev.name, input: ev.input },
          });
          broadcast(`session:${ctx.id}`, {
            type: 'run_log',
            sessionId: ctx.id,
            stream: 'stdout',
            chunk: `$ ${summary}\n`,
          });
          break;
        }
        case 'tool_result': {
          const text = ev.text.endsWith('\n') ? ev.text : `${ev.text}\n`;
          broadcast(`session:${ctx.id}`, {
            type: 'run_log',
            sessionId: ctx.id,
            stream: ev.stream,
            chunk: text,
          });
          break;
        }
        case 'message_stop':
          closeStream();
          break;
        case 'final_text_fallback': {
          const id = ensureStream();
          streamContent += ev.text;
          totalText += ev.text;
          broadcast(`session:${ctx.id}`, {
            type: 'stream_chunk',
            sessionId: ctx.id,
            messageId: id,
            chunk: ev.text,
          });
          break;
        }
        case 'model':
          if (!streamModel) streamModel = ev.model;
          break;
      }
    }
  } finally {
    try {
      run.close();
    } catch {
      // best-effort cleanup
    }
  }

  closeStream();
  return totalText;
}

async function runAssistant(
  ctx: SessionContext,
  prompt: string,
  planItemId: string | null,
  planItems: PlanItemLite[],
  images: ImageInput[] = [],
  model?: string,
): Promise<void> {
  broadcast(`session:${ctx.id}`, { type: 'run_status', sessionId: ctx.id, status: 'started' });

  const pinsContext = buildPinsContext(ctx.id);
  const envVarsContext = buildEnvVarsContext();
  const systemPrompt =
    SYSTEM_PROMPT +
    buildPlanContext(planItems) +
    buildWikiContext(ctx.projectId) +
    envVarsContext +
    (pinsContext ? `\n\n${pinsContext}` : '');

  const abortController = registerRun(ctx.id);

  try {
    let finalText = '';

    if (ctx.claudeSessionId) {
      try {
        finalText = await runAttempt(
          ctx,
          prompt,
          images,
          planItemId,
          systemPrompt,
          true,
          abortController,
          model,
        );
      } catch (err) {
        if (abortController.signal.aborted) throw err;
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

    if (!ctx.claudeSessionId && !abortController.signal.aborted) {
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
        images,
        planItemId,
        systemPrompt,
        false,
        abortController,
        model,
      );
    }

    if (abortController.signal.aborted) {
      persistMessage({
        sessionId: ctx.id,
        planItemId,
        role: 'system',
        content: '[cancelled by user]',
      });
      broadcast(`session:${ctx.id}`, {
        type: 'run_status',
        sessionId: ctx.id,
        status: 'error',
        error: 'cancelled',
      });
      return;
    }

    // Streaming already persisted the assistant message in runAttempt.
    // finalText is retained for possible callers but no extra persist here.
    void finalText;

    broadcast(`session:${ctx.id}`, {
      type: 'run_status',
      sessionId: ctx.id,
      status: 'finished',
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      persistMessage({
        sessionId: ctx.id,
        planItemId,
        role: 'system',
        content: '[cancelled by user]',
      });
      broadcast(`session:${ctx.id}`, {
        type: 'run_status',
        sessionId: ctx.id,
        status: 'error',
        error: 'cancelled',
      });
      return;
    }
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
  } finally {
    clearRun(ctx.id, abortController);
  }
}
