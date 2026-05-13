import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import type { Message, MessageRole } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { getAgentAdapter } from './agents/index.js';
import type {
  AgentRun,
  McpStdioServerConfig,
  NormalizedEvent,
} from './agents/types.js';
import { listUserEnvVars } from './user-env.js';
import {
  getMemberBySessionId,
  getTeamByOrchestratorSessionId,
} from './teams.js';
import { mintTeamToken } from './team-tokens.js';
import { emitDispatchEvent } from './team-events.js';
import {
  broadcastQueueState,
  drainQueue,
  enqueueMessage,
  listQueueItems,
  listSessionsWithQueuedItems,
  setTeamWorkerQueueHook,
} from './message-queue.js';
import { redactSecrets } from './redact.js';
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
- Be concise. Show code blocks only when useful. Use Korean if the user writes in Korean.
- Before kicking off multi-tool work on a substantive task (analysis, refactor,
  deep search), lead with one short line so the user sees something is
  happening. For trivial replies (a greeting, yes/no, a tiny answer), skip
  the preamble.
- A user message wrapped with "[Interrupted mid-task ...]" arrived while
  you were working on a previous task. Reply naturally to the new messages,
  then add ONE short sentence saying the previous task is paused and ask
  whether to resume or switch. Refer to the paused work generically (e.g.,
  "the previous task is paused"). Do NOT: quote the original prompt back,
  use temporal back-references ("earlier", "previously", or their
  equivalents in any language), wrap the notice in parentheses, or repeat
  the interruption marker.`;

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

// Worker instructions are capped at 4000 chars in the service layer
// (per member). Inlining N of those into the orchestrator's team
// context every turn is a real bloat risk — 20 workers × 4000 chars =
// ~80kb of duplicated prompt that also degrades routing. Worker
// self-prompt uses the full text; only the orchestrator's listing is
// summarized.
const ORCHESTRATOR_INSTRUCTIONS_SUMMARY_CHARS = 280;

// If `sessionId` is the orchestrator of a team, return a markdown block
// describing the workers and the dispatch tools available via the
// pinloom MCP server. Empty string for non-orchestrator sessions —
// they don't get the MCP wired up either, so the prompt stays clean.
function buildTeamContext(sessionId: string): string {
  const team = getTeamByOrchestratorSessionId(sessionId);
  if (!team) return '';
  // The orchestrator's own briefing — analogous to a worker's
  // `### Instructions` block but inlined verbatim because there's
  // exactly one of these per team (no per-N cost concern).
  const orchInstructionsBlock = team.instructions
    ? ['', '### Briefing', '', team.instructions]
    : [];
  if (team.members.length === 0) {
    return [
      '',
      '## Team orchestration',
      '',
      `You are the orchestrator of team **${team.name}**, but no workers are`,
      'attached yet. Ask the user to add workers via the Teams page before',
      'attempting to dispatch.',
      ...orchInstructionsBlock,
    ].join('\n');
  }
  const db = getDb();
  // We always list `team_send_tag` so the orchestrator knows the tool
  // exists — hiding it until ≥1 worker has tags created a discovery
  // gap (users would tag workers mid-session expecting broadcast, but
  // the orchestrator's prompt was already cached without the tool).
  // The phrasing notes it's a no-op when nothing matches so the
  // orchestrator doesn't burn tokens on a useless probe.
  const hasAnyTags = team.members.some((m) => m.tags.length > 0);
  const workerLines: string[] = [];
  for (const m of team.members) {
    const session = db
      .prepare('SELECT agent, project_id FROM sessions WHERE id = ?')
      .get(m.sessionId) as
      | { agent: 'claude' | 'codex' | null; project_id: string }
      | undefined;
    if (!session) continue;
    const project = db
      .prepare('SELECT name FROM projects WHERE id = ?')
      .get(session.project_id) as { name: string } | undefined;
    const agent = session.agent ?? 'claude';
    const projectPart = project ? `, project ${project.name}` : '';
    const tagsPart =
      m.tags.length > 0 ? `, tags: ${m.tags.map((t) => `#${t}`).join(' ')}` : '';
    workerLines.push(`- **@${m.alias}** (${agent}${projectPart}${tagsPart})`);
    if (m.instructions) {
      // Aggressively summarize for the orchestrator listing — the full
      // instructions text lives in the worker's own systemPrompt
      // (buildWorkerInstructionsContext) where it actually drives
      // behavior. Here we just need enough for the orchestrator to
      // route work to the right alias; long instructions inlined N
      // times would otherwise crowd the orchestrator's prompt and
      // degrade routing accuracy. Single line, hard cap at ~280 chars.
      const flattened = m.instructions.replace(/\s+/g, ' ').trim();
      const truncated =
        flattened.length > ORCHESTRATOR_INSTRUCTIONS_SUMMARY_CHARS
          ? `${flattened.slice(0, ORCHESTRATOR_INSTRUCTIONS_SUMMARY_CHARS)}…`
          : flattened;
      workerLines.push(`  ${truncated}`);
    }
  }
  return [
    '',
    `## Team orchestration — you are the orchestrator of team "${team.name}"`,
    ...orchInstructionsBlock,
    '',
    'You can dispatch tasks to the workers below by calling the pinloom MCP',
    'tools. Each worker is its own session with its own agent, model, and',
    'project — pick the right alias for the job.',
    '',
    'Workers:',
    ...workerLines,
    '',
    'Available tools (auto-injected via MCP):',
    '- `team_list()` — re-fetch worker status if needed',
    '- `team_ask(alias, text, timeoutMs?)` — **default delegation tool**: send a prompt and block until the worker replies; returns the reply directly as the tool_result. Mirrors the SDK\'s Task tool — your turn stays alive across the round trip.',
    `- \`team_ask_tag(tag, text, timeoutMs?)\` — broadcast variant of team_ask: sends to every worker with that tag and waits for all in parallel${
      hasAnyTags ? '' : ' (no-op until at least one worker is tagged)'
    }`,
    '- `team_send(alias, text)` — fire-and-forget alternative to team_ask. Use only when you genuinely want to kick off a long task and continue other work in the same turn; otherwise prefer team_ask.',
    `- \`team_send_tag(tag, text)\` — fire-and-forget broadcast variant${
      hasAnyTags ? '' : ' (no-op until at least one worker is tagged)'
    }`,
    '- `team_update_member(alias, newAlias?, instructions?, tags?)` — sharpen an existing worker\'s role mid-session (cannot add/remove workers)',
    '- `team_read(alias, sinceMessageId?)` — read a worker\'s recent reply (use after team_send when you went the async route, or to re-check earlier history)',
    '- `team_status(alias)` — check if a worker is idle/running',
    '- `team_wait(alias, timeoutMs?)` — block until a worker is idle (used with team_send pattern; team_ask waits internally)',
    '',
    'Default pattern: call `team_ask` (or `team_ask_tag`) and synthesize',
    'across the returned replies in the same turn. Workers don\'t see each',
    'other; you are the only one that can synthesize across them.',
    '',
    'When in doubt: `team_ask`. Reach for `team_send` ONLY when the user',
    'explicitly said "kick off" / "in the background" / "don\'t wait" — or',
    'when you genuinely intend to keep doing other work in the same turn',
    'without that worker\'s reply. Otherwise the round trip stalls because',
    'fire-and-forget replies do not auto-wake your next turn.',
    '',
    '### Dispatch must be a tool call, not a description',
    '',
    'Writing "dispatching to @alias" / "sending to #review" / "broadcasting"',
    'in your reply does NOT send anything — workers receive only what arrives',
    'via the MCP tool. If you announce a dispatch in the SAME turn, you must',
    'invoke `team_ask` (or its tag variant) in that same turn or the worker',
    'gets nothing and the user has to ask again. If you are still planning',
    'and not ready to dispatch, phrase it explicitly as a future step',
    '("Next: I\'ll ask @alias once ...") so the user knows the work hasn\'t',
    'left this session yet.',
  ].join('\n');
}

// If `sessionId` is a worker in some team, inject a short block
// telling the agent who it's playing in this team plus its instructions
// (if any). Empty string for free sessions and orchestrators (which
// already get their own block via buildTeamContext). Workers don't get
// the dispatch tools — only the orchestrator's MCP server is wired up
// — so this is purely identity / role context.
function buildWorkerInstructionsContext(sessionId: string): string {
  const member = getMemberBySessionId(sessionId);
  if (!member) return '';
  // A worker with neither instructions nor tags doesn't need any extra
  // context — the orchestrator's MCP messages already prefix
  // `[from orchestrator]` so role attribution is unambiguous, and
  // pre-migration rows (NULL instructions + NULL tags) shouldn't
  // suddenly grow a heading after upgrade.
  if (!member.instructions && member.tags.length === 0) return '';
  const lines = [
    '',
    `## Team role — you are worker @${member.alias}`,
    '',
    'You are part of a team coordinated by an orchestrator session.',
    'Treat messages prefixed with `[from orchestrator]` as the lead asking',
    'you to do focused work; reply concisely so the orchestrator can',
    'synthesize across workers.',
  ];
  if (member.tags.length > 0) {
    lines.push('', `Tags: ${member.tags.map((t) => `#${t}`).join(' ')}`);
  }
  if (member.instructions) {
    lines.push('', '### Instructions', '', member.instructions);
  }
  return lines.join('\n');
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

// One long-lived agent run per session. New user messages route through
// `pushMessage` so the agent picks them up at the next turn boundary instead
// of being torn down and restarted. The run lives until cancelled, errored,
// or the agent's event stream ends naturally (mock-driven test paths only).
interface ActiveRun {
  agentRun: AgentRun;
  abortController: AbortController;
  // The plan item id events should be tagged with right now.
  currentPlanItemId: string | null;
  // Set by sendUserMessage when a new prompt is queued mid-run; adopted by
  // the event loop on the next `turn_complete` so events flowing in for the
  // queued prompt land under the correct plan item.
  pendingPlanItemId: string | null;
  hasPendingPlanItem: boolean;
  // True while the agent is producing output — flips on push, off on
  // turn_complete. Drives `isAiRunning` for the run-status endpoint.
  inFlight: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

// Distinct cancel intents passed via AbortController.abort(reason). The
// AttemptResult derives `silent` by inspecting `signal.reason` instead of
// reading a mutable flag on ActiveRun, so the cancel decision is colocated
// with the abort itself.
class UserCancelled extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'UserCancelled';
  }
}
class SilentCancelled extends Error {
  constructor() {
    super('cancelled to splice queued message');
    this.name = 'SilentCancelled';
  }
}

// Single teardown path used by both Stop button (loud) and queue-drain
// interrupt (silent). Always deregisters before aborting so any caller
// that immediately starts a new run sees an empty slot. The consumer
// loop's `finally` is race-safe (identity check) so the same entry won't
// be deleted twice.
function stopRun(sessionId: string, opts: { silent: boolean }): boolean {
  const run = activeRuns.get(sessionId);
  if (!run) return false;
  activeRuns.delete(sessionId);
  run.abortController.abort(
    opts.silent ? new SilentCancelled() : new UserCancelled(),
  );
  try {
    run.agentRun.close();
  } catch {
    // best-effort
  }
  // Loud cancel still surfaces as "idle" to team_wait subscribers; silent
  // cancel does too because the runner immediately starts a fresh attempt
  // so the listener will re-check isAiRunning and stay subscribed.
  notifySessionIdle(sessionId);
  return true;
}

export function cancelAiRun(sessionId: string): boolean {
  return stopRun(sessionId, { silent: false });
}

export function isAiRunning(sessionId: string): boolean {
  const run = activeRuns.get(sessionId);
  return !!run && run.inFlight;
}

// Promise-based "wait until session is idle" helper — primarily used by
// the team-dispatch routes for `team_wait`. Resolves with `true` when
// the session is idle, `false` on timeout or abort. Hooks into a tiny
// per-session listener Set that's notified by the run-attempt loop's
// finally block when a run wraps up. Subscribers register *before*
// checking inFlight to avoid a race where the run ends between their
// check and their subscribe.
const idleListeners = new Map<string, Set<() => void>>();

// Wire the message-queue's broadcast path to also fan a worker_status
// event into the team channel — covers the "user typed directly into a
// worker chat" case which otherwise wouldn't repaint the canvas until
// a run actually started/ended.
setTeamWorkerQueueHook((sessionId: string) => {
  emitWorkerStatusIfMember(sessionId);
});

// Emits a `worker_status` dispatch event if this session is a worker in
// some team. Drives the descriptive canvas's node pulse (PR3). Lookup
// is one SQLite hit; safe to call frequently.
function emitWorkerStatusIfMember(sessionId: string): void {
  const row = getDb()
    .prepare(
      `SELECT t.id AS team_id, m.alias AS alias
       FROM team_members m
       JOIN teams t ON t.id = m.team_id
       WHERE m.session_id = ?`,
    )
    .get(sessionId) as { team_id: string; alias: string } | undefined;
  if (!row) return;
  emitDispatchEvent({
    type: 'worker_status',
    teamId: row.team_id,
    alias: row.alias,
    sessionId,
    running: isAiRunning(sessionId),
    queued: listQueueItems(sessionId).length,
    at: new Date().toISOString(),
  });
}

function notifySessionIdle(sessionId: string): void {
  const set = idleListeners.get(sessionId);
  if (!set) return;
  // Snapshot first — listeners may unsubscribe synchronously inside the
  // callback, mutating the set we'd otherwise be iterating.
  const callbacks = [...set];
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // best-effort — one bad listener shouldn't break the rest
    }
  }
}

export function waitForIdle(
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const set = idleListeners.get(sessionId) ?? new Set<() => void>();
    idleListeners.set(sessionId, set);

    function cleanup() {
      clearTimeout(timer);
      set.delete(onIdle);
      if (set.size === 0) idleListeners.delete(sessionId);
      signal?.removeEventListener('abort', onAbort);
    }
    function onIdle() {
      // Re-check actual state — the listener fires on every run end but
      // there may still be queued items waiting to be drained.
      if (isAiRunning(sessionId) || getQueueDepthFor(sessionId) > 0) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    }
    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }

    // CRITICAL ORDER: subscribe BEFORE the early-out check. If we
    // checked first and the run completed between the check and the
    // subscribe, our listener would be registered too late and we'd
    // hang for the full timeout.
    set.add(onIdle);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }, timeoutMs);

    // Now safe to fast-path resolve if already idle.
    if (!isAiRunning(sessionId) && getQueueDepthFor(sessionId) === 0) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    }
  });
}

// Tiny indirection so the queue depth lookup doesn't need to import
// message-queue at module load time (would create a cycle with runner →
// message-queue → broadcast → … in some refactors).
function getQueueDepthFor(sessionId: string): number {
  return listQueueItems(sessionId).length;
}

// Called once on backend startup. The message_queue table survives backend
// restarts but `activeRuns` doesn't, so any session that had queued items
// from a previous process would otherwise sit idle forever — its drain
// triggers (runner events) only fire while a run is alive. Walk every
// stranded session and kick off a drain so the user's typed-but-never-sent
// messages actually reach the agent on next boot.
export function drainStrandedQueuesOnBoot(): void {
  for (const sessionId of listSessionsWithQueuedItems()) {
    if (!isAiRunning(sessionId)) {
      tryDrainQueue(sessionId);
    }
  }
}

// Atomically drain the session's pending message queue and route the
// drained items into the agent. Called at every turn boundary by the
// runner's event loop, and immediately after enqueue when the user
// types into an idle session.
//
// - inFlight === true → silent abort + restart with combined prompt
// - inFlight === false (idle) or no active run → just push (or start fresh)
//
// Schedules itself off the call stack via queueMicrotask so the runner's
// event handler can return before sendUserMessages tears down the run
// it's still consuming events from.
export function tryDrainQueue(sessionId: string): void {
  const items = drainQueue(sessionId);
  if (items.length === 0) return;
  broadcastQueueState(sessionId);

  const active = activeRuns.get(sessionId);
  const interrupt = active?.inFlight === true;
  // Use the most recently queued model — that's the user's freshest
  // intent. null falls through to the session's existing model.
  const model = items[items.length - 1]?.model ?? undefined;

  queueMicrotask(() => {
    void sendUserMessages(
      sessionId,
      items.map((i) => ({ content: i.content })),
      model,
      { interrupt },
    ).catch((err) => {
      // Send failed before the agent run was kicked off — re-enqueue the
      // drained items so the user's typed messages aren't lost. Order is
      // preserved by re-inserting in the original sequence; any items the
      // user enqueued in the meantime stay after these.
      for (const item of items) {
        try {
          enqueueMessage({
            sessionId,
            content: item.content,
            model: item.model,
          });
        } catch {
          // best-effort — if re-enqueue itself fails (e.g., session
          // deleted mid-flight), there's nothing useful left to do.
        }
      }
      broadcastQueueState(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      broadcast(`session:${sessionId}`, {
        type: 'run_status',
        sessionId,
        status: 'error',
        error: msg,
      });
    });
  });
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

interface BatchMessage {
  content: string;
  planItemId?: string | null;
  images?: ImageInput[];
}

// Single entry point for both the chat UI's direct send and the queue-drain
// batch send. Each message is persisted as its own USER row (so the chat
// shows N bubbles), but everything is combined into ONE agent prompt — for
// length 1 that's just the message itself, and for length N a `\n\n`-joined
// paragraph block. The agent answers all of them in one response, matching
// Claude Code's "drained-at-turn-boundary" UX.
//
// `interrupt: true` says "stop the current in-flight turn silently and
// restart from the same resume point with these prompts." Used by the
// queue's mid-turn drain so the user doesn't see a `[cancelled by user]`
// row when the agent gets spliced.
export async function sendUserMessages(
  sessionId: string,
  messages: BatchMessage[],
  model?: string,
  options?: { interrupt?: boolean },
): Promise<Message[]> {
  if (messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const ctx = loadSession(sessionId);
  if (!ctx) throw new Error(`session ${sessionId} not found`);

  // Interrupt mode: stop the current run silently before persisting new
  // user rows so it doesn't leave a "[cancelled by user]" row in chat;
  // the new run we kick off below resumes from the same agent_session_id,
  // so the agent picks up where it left off + the new prompts as one turn.
  if (options?.interrupt) {
    stopRun(sessionId, { silent: true });
  }

  const planItems = loadPlanItems(ctx.planId);

  const persisted: Message[] = [];
  const resolvedIds: (string | null)[] = [];
  let totalImages = 0;
  for (const m of messages) {
    const pid = m.planItemId ?? resolveMentionedItem(m.content, planItems);
    resolvedIds.push(pid);
    persisted.push(
      persistMessage({
        sessionId,
        planItemId: pid,
        role: 'user',
        content: m.content,
      }),
    );
    totalImages += m.images?.length ?? 0;
  }

  if (totalImages > 0) {
    getDb()
      .prepare(
        'UPDATE sessions SET next_image_number = next_image_number + ? WHERE id = ?',
      )
      .run(totalImages, sessionId);
  }

  // Combine into a single agent prompt. Each message keeps its own
  // paragraph; the agent reads them as the user's stacked input over the
  // previous turn. For interrupt-mode (mid-task drains), prepend a small
  // marker so the system prompt's "natural aside" rule kicks in — without
  // it the model doesn't know the previous task got paused, so it just
  // answers tersely and forgets to offer to resume.
  const joinedMessages = messages.map((m) => m.content).join('\n\n');
  const combinedText = options?.interrupt
    ? `[Interrupted mid-task]\n\n${joinedMessages}`
    : joinedMessages;
  const combinedImages = messages.flatMap((m) => m.images ?? []);
  // Pin the agent's response to the LAST queued message — the most recent
  // intent is the most likely owner of any tool/plan changes that follow.
  const lastPlanItemId = resolvedIds[resolvedIds.length - 1];

  const existing = activeRuns.get(sessionId);
  if (existing) {
    // Mid-run injection. Plan-item rollover depends on whether a turn is
    // currently in flight: if yes, queue the new id and let the next
    // `turn_complete` adopt it (so events for the current turn keep the
    // old tag); if no (we're idle between turns), adopt immediately
    // because no turn_complete will fire before the queued message's
    // events arrive.
    if (existing.inFlight) {
      existing.pendingPlanItemId = lastPlanItemId;
      existing.hasPendingPlanItem = true;
    } else {
      existing.currentPlanItemId = lastPlanItemId;
      existing.pendingPlanItemId = null;
      existing.hasPendingPlanItem = false;
    }
    existing.inFlight = true;
    existing.agentRun.pushMessage({ text: combinedText, images: combinedImages });
    broadcast(`session:${sessionId}`, {
      type: 'run_status',
      sessionId,
      status: 'started',
    });
    // Repaint the canvas: worker just transitioned idle → running mid-
    // AgentRun (next turn starts via pushMessage rather than a fresh
    // adapter spawn).
    emitWorkerStatusIfMember(sessionId);
    return persisted;
  }

  // No active run — kick one off with the combined prompt.
  runAssistant(
    ctx,
    combinedText,
    lastPlanItemId,
    planItems,
    combinedImages,
    model,
  ).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    persistMessage({
      sessionId,
      planItemId: lastPlanItemId,
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

  return persisted;
}

// Thin compatibility wrapper for the single-message direct send path.
// Kept for the existing /api/sessions/:id/messages route's signature; the
// real work happens in sendUserMessages with a single-element array.
export async function sendUserMessage(
  sessionId: string,
  content: string,
  planItemId: string | null = null,
  images: ImageInput[] = [],
  model?: string,
): Promise<Message> {
  const [persisted] = await sendUserMessages(
    sessionId,
    [{ content, planItemId, images }],
    model,
  );
  return persisted;
}

interface AttemptResult {
  // True when the attempt threw before producing useful output and a fallback
  // (no-resume) attempt should be tried next. False when the attempt either
  // succeeded, was cancelled, or errored after streaming started.
  shouldFallback: boolean;
  cancelled: boolean;
  // True when the cancellation was initiated to splice in queued messages
  // (`stopRun({silent:true})`), not by the user pressing Stop. Derived
  // from `signal.reason instanceof SilentCancelled`. runAssistant uses
  // this to suppress the chat-visible "[cancelled by user]" row + error.
  silent: boolean;
  // True when the attempt ended because the adapter surfaced an
  // `adapter_error` event (credential / bridge connect / auth-401 /
  // conflict). The error has already been persisted as a system
  // message and broadcast as a run_status:error; the caller should
  // skip the cancelled-by-user branch (this is NOT a user cancel)
  // and the finished broadcast (the run is over).
  adapterErrored?: boolean;
}

// Resolve the bundled MCP server entry once at module load. createRequire
// looks up `@pinloom/mcp-server` against this file's URL — works in both
// dev (tsx watching src/) and prod (built dist/) layouts because the
// package has a `main` pointing at its built entry. Returns null if the
// package isn't installed (defensive — pnpm workspace should always
// resolve it, but a missing build shouldn't crash the runner).
const requireFromHere = createRequire(import.meta.url);
function resolveMcpServerEntry(): string | null {
  try {
    return requireFromHere.resolve('@pinloom/mcp-server');
  } catch {
    return null;
  }
}
const MCP_SERVER_ENTRY = resolveMcpServerEntry();

// If the given session is an orchestrator, mint a fresh per-run token
// and return the MCP server config to inject. Workers and untethered
// sessions get null — they don't need MCP wiring.
function buildOrchestratorMcpConfig(
  sessionId: string,
): Record<string, McpStdioServerConfig> | undefined {
  if (!MCP_SERVER_ENTRY) return undefined;
  const team = getTeamByOrchestratorSessionId(sessionId);
  if (!team) return undefined;
  const token = mintTeamToken(team.id);
  return {
    pinloom: {
      command: process.execPath, // current Node binary
      args: [MCP_SERVER_ENTRY],
      env: {
        PINLOOM_TEAM_ID: team.id,
        PINLOOM_TEAM_TOKEN: token,
        // Default backend URL is fine for local dev; expose an override
        // hook in case the user runs pinloom on a non-standard port.
        ...(process.env.PINLOOM_MCP_BACKEND_URL
          ? { PINLOOM_BACKEND_URL: process.env.PINLOOM_MCP_BACKEND_URL }
          : {}),
      },
    },
  };
}

async function runAttempt(
  ctx: SessionContext,
  prompt: string,
  images: ImageInput[],
  initialPlanItemId: string | null,
  systemPrompt: string,
  useResume: boolean,
  model?: string,
  mcpServers?: Record<string, McpStdioServerConfig>,
): Promise<AttemptResult> {
  const adapter = getAgentAdapter(ctx.agent, ctx.id);
  const abortController = new AbortController();
  const agentRun = adapter.run({
    cwd: ctx.cwd,
    systemPrompt,
    model,
    resume: useResume ? ctx.claudeSessionId : null,
    abortController,
    initialPrompt: { text: prompt, images },
    mcpServers,
    sessionId: ctx.id,
  });

  const active: ActiveRun = {
    agentRun,
    abortController,
    currentPlanItemId: initialPlanItemId,
    pendingPlanItemId: null,
    hasPendingPlanItem: false,
    inFlight: true,
  };
  activeRuns.set(ctx.id, active);
  emitWorkerStatusIfMember(ctx.id);

  let streamMsgId: string | null = null;
  let streamContent = '';
  let streamModel: string | null = null;
  let producedAnyContent = false;

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
      planItemId: active.currentPlanItemId,
      role: 'assistant',
      content: '',
    });
    streamMsgId = created.id;
    streamContent = '';
    return created.id;
  }

  let attemptError: unknown = null;
  let adapterErrored = false;

  try {
    for await (const ev of agentRun.events as AsyncIterable<NormalizedEvent>) {
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
          // Redact any user-marked secret value before it reaches the chat
          // row OR the WS broadcast — the agent should never echo these,
          // but if it does (printenv, debug logs, etc.), we strip them.
          const safeText = redactSecrets(ev.text);
          streamContent += safeText;
          producedAnyContent = true;
          broadcast(`session:${ctx.id}`, {
            type: 'stream_chunk',
            sessionId: ctx.id,
            messageId: id,
            chunk: safeText,
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
            chunk: redactSecrets(ev.text),
          });
          break;
        case 'tool_use': {
          closeStream();
          const summary = redactSecrets(ev.summary ?? ev.name);
          persistMessage({
            sessionId: ctx.id,
            planItemId: active.currentPlanItemId,
            role: 'tool',
            content: summary,
            toolUse: { name: ev.name, input: ev.input },
          });
          producedAnyContent = true;
          broadcast(`session:${ctx.id}`, {
            type: 'run_log',
            sessionId: ctx.id,
            stream: 'stdout',
            chunk: `$ ${summary}\n`,
          });
          break;
        }
        case 'tool_result': {
          const redactedText = redactSecrets(ev.text);
          const text = redactedText.endsWith('\n')
            ? redactedText
            : `${redactedText}\n`;
          broadcast(`session:${ctx.id}`, {
            type: 'run_log',
            sessionId: ctx.id,
            stream: ev.stream,
            chunk: text,
          });
          // Tool result is back, the agent is about to think about its
          // next step — a natural break point to splice in any queued
          // mid-task messages. Critical for tool-heavy turns where the
          // agent never streams free text (e.g., "analyze the project"
          // runs 10+ Reads in a row), so text_block_end alone wouldn't
          // trigger a drain.
          tryDrainQueue(ctx.id);
          break;
        }
        case 'text_block_end': {
          // Only treat this as a "natural break" if we just closed a
          // real assistant text stream. The Claude adapter also yields
          // text_block_end right before each tool_use block (so we close
          // any in-flight text first); draining there interrupts the
          // agent before the user has seen ANY output, which makes the
          // first turn's work disappear from chat. Limit drains to
          // post-text breaks — same shape as Claude Code's "agent said
          // something, now is a fine time to splice in".
          const justClosedText = streamMsgId !== null;
          closeStream();
          if (justClosedText) {
            tryDrainQueue(ctx.id);
          }
          break;
        }
        case 'turn_complete':
          closeStream();
          // Adopt the next queued plan item (if any) so events for the
          // upcoming turn land under it.
          if (active.hasPendingPlanItem) {
            active.currentPlanItemId = active.pendingPlanItemId;
            active.pendingPlanItemId = null;
            active.hasPendingPlanItem = false;
          }
          active.inFlight = false;
          broadcast(`session:${ctx.id}`, {
            type: 'run_status',
            sessionId: ctx.id,
            status: 'finished',
          });
          // Anything the user typed during this turn now goes into the
          // next one — no interrupt needed, the run is idle.
          tryDrainQueue(ctx.id);
          // Wake any team_wait waiters AND repaint the canvas. Without
          // these, a long-lived AgentRun (Codex resume / Claude SDK) sits
          // at inFlight=false between turns but no one observing the
          // session knows — team_wait stalls until the AgentRun fully
          // ends, the canvas keeps "running" indefinitely.
          notifySessionIdle(ctx.id);
          emitWorkerStatusIfMember(ctx.id);
          break;
        case 'final_text_fallback': {
          const id = ensureStream();
          const safeText = redactSecrets(ev.text);
          streamContent += safeText;
          producedAnyContent = true;
          broadcast(`session:${ctx.id}`, {
            type: 'stream_chunk',
            sessionId: ctx.id,
            messageId: id,
            chunk: safeText,
          });
          break;
        }
        case 'model':
          if (!streamModel) streamModel = ev.model;
          break;
        case 'inbound_user_message': {
          // A prompt that arrived from outside pinloom (currently:
          // claude.ai via the remote-control bridge). Close any
          // in-flight assistant stream first so the user row doesn't
          // get appended to an unfinished message, then persist as a
          // `role: 'user'` row — `persistMessage` broadcasts the
          // `message` event so the UI updates immediately.
          closeStream();
          persistMessage({
            sessionId: ctx.id,
            planItemId: active.currentPlanItemId,
            role: 'user',
            content: ev.text,
          });
          break;
        }
        case 'adapter_error': {
          // Adapter-layer failure (credential, bridge auth/conflict,
          // network). Close any in-flight assistant stream first so the
          // error doesn't get appended to an unfinished message, then
          // persist as a system message — `persistMessage` already
          // broadcasts the `message` event, we just add a run_status
          // so the UI can show an error banner. This is the dedicated
          // channel that replaces PR 1's "[remote-control] …" via
          // final_text_fallback workaround.
          //
          // Set `adapterErrored` so the caller skips the
          // cancelled-by-user branch (the adapter MUST NOT abort the
          // controller — abort means user-initiated cancel). The
          // for-await loop will end naturally when the adapter closes
          // its event queue.
          closeStream();
          persistMessage({
            sessionId: ctx.id,
            planItemId: active.currentPlanItemId,
            role: 'system',
            content: `[adapter:${ev.kind}] ${ev.detail}`,
          });
          broadcast(`session:${ctx.id}`, {
            type: 'run_status',
            sessionId: ctx.id,
            status: 'error',
            error: `${ev.kind}: ${ev.detail}`,
          });
          adapterErrored = true;
          break;
        }
      }
    }
  } catch (err) {
    attemptError = err;
  } finally {
    closeStream();
    try {
      agentRun.close();
    } catch {
      // best-effort cleanup
    }
    if (activeRuns.get(ctx.id) === active) {
      activeRuns.delete(ctx.id);
    }
    // A team_send dispatch that arrived during the dying tail (after the
    // last event-loop drain trigger but before activeRuns.delete) would
    // otherwise sit in the queue until the next user message. Try to
    // drain now while the session is verifiably idle.
    tryDrainQueue(ctx.id);
    notifySessionIdle(ctx.id);
    emitWorkerStatusIfMember(ctx.id);
  }

  if (adapterErrored) {
    // Adapter surfaced its own failure event; the system message and
    // run_status:error are already out. Don't double-report via the
    // cancelled-by-user or runAssistant catch paths.
    return {
      shouldFallback: false,
      cancelled: false,
      silent: false,
      adapterErrored: true,
    };
  }
  if (abortController.signal.aborted) {
    return {
      shouldFallback: false,
      cancelled: true,
      silent: abortController.signal.reason instanceof SilentCancelled,
    };
  }
  if (attemptError) {
    // Fall back only when resume was being attempted AND we never streamed
    // any meaningful output (the resume token was stale on the agent side).
    if (useResume && !producedAnyContent) {
      return { shouldFallback: true, cancelled: false, silent: false };
    }
    throw attemptError;
  }
  return { shouldFallback: false, cancelled: false, silent: false };
}

async function runAssistant(
  ctx: SessionContext,
  prompt: string,
  initialPlanItemId: string | null,
  planItems: PlanItemLite[],
  images: ImageInput[] = [],
  model?: string,
): Promise<void> {
  broadcast(`session:${ctx.id}`, { type: 'run_status', sessionId: ctx.id, status: 'started' });

  const pinsContext = buildPinsContext(ctx.id);
  const envVarsContext = buildEnvVarsContext();
  // A session is at most one of: orchestrator OR worker, so these two
  // builders never both produce content for the same systemPrompt.
  const teamContext = buildTeamContext(ctx.id);
  const workerInstructionsContext = buildWorkerInstructionsContext(ctx.id);
  const systemPrompt =
    SYSTEM_PROMPT +
    buildPlanContext(planItems) +
    buildWikiContext(ctx.projectId) +
    envVarsContext +
    teamContext +
    workerInstructionsContext +
    (pinsContext ? `\n\n${pinsContext}` : '');

  // Mint the orchestrator's MCP token ONCE per turn (i.e. per
  // runAssistant call), not once per runAttempt. Resume + fallback
  // attempts share the same token so the still-spawned child process
  // from the first attempt — if any — keeps authenticating until it
  // exits. Per-attempt minting would 403 the first attempt's child the
  // moment the fallback ran.
  const mcpServers = buildOrchestratorMcpConfig(ctx.id);

  let result: AttemptResult = { shouldFallback: false, cancelled: false, silent: false };

  // Adapters that manage their own session lifecycle (remote-control via
  // the Anthropic bridge) opt out of pinloom's resume + stale-resume
  // fallback ladder — feeding them a claudeSessionId would either be a
  // no-op or trigger a fabricated fallback prompt. Resolve the adapter
  // once here so the decision is consistent within this runAssistant
  // call.
  const adapter = getAgentAdapter(ctx.agent, ctx.id);
  const canResume = adapter.supportsResume !== false;

  try {
    if (ctx.claudeSessionId && canResume) {
      try {
        result = await runAttempt(
          ctx,
          prompt,
          images,
          initialPlanItemId,
          systemPrompt,
          true,
          model,
          mcpServers,
        );
      } catch (err) {
        // Hard error after the attempt produced output — surface as runner
        // error rather than fall back blindly.
        throw err;
      }

      if (result.shouldFallback) {
        const errMsg = '(stale resume token)';
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

    // The second-attempt branch covers three cases:
    //   1. canResume === false (the adapter opted out — only one attempt
    //      ever runs, useResume=false; this branch IS that attempt).
    //   2. ctx.claudeSessionId was null to begin with (fresh session).
    //   3. The first attempt cleared claudeSessionId via shouldFallback.
    if ((!ctx.claudeSessionId || !canResume) && !result.cancelled) {
      // Fallback race guard: between the first attempt's deregister and the
      // second attempt's register, an interrupt path may have spliced in a
      // brand-new run for this session (silent-cancel saw nothing in
      // activeRuns to abort, so it just started fresh). If that happened,
      // the new run is already handling the user's current intent — bail
      // out instead of starting a competing fallback.
      if (activeRuns.has(ctx.id)) {
        return;
      }
      const userMsgRow = getDb()
        .prepare(
          'SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(ctx.id, 'user') as { id: string } | undefined;
      const history = loadRecentHistory(ctx.id, userMsgRow?.id ?? '');
      const fallbackPrompt =
        history.length > 0 && result.shouldFallback
          ? buildFallbackPrompt(history, prompt)
          : prompt;
      result = await runAttempt(
        ctx,
        fallbackPrompt,
        images,
        initialPlanItemId,
        systemPrompt,
        false,
        model,
        mcpServers,
      );
    }

    if (result.adapterErrored) {
      // Adapter already persisted a [adapter:kind] system message and
      // broadcast run_status:error. The run is over; skip the finished
      // broadcast at the bottom of the try block.
      return;
    }
    if (result.cancelled) {
      // Silent cancel = orchestrator interrupted us to splice in queued
      // messages. The replacement run is already starting; suppress chat
      // noise so the UI looks like one seamless conversation.
      if (result.silent) return;
      persistMessage({
        sessionId: ctx.id,
        planItemId: initialPlanItemId,
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
    // Run-level `finished` covers the case where the agent's event stream
    // ended without a `turn_complete` (mock SDK in tests, or rare SDK edge
    // cases). Per-turn `finished` is already broadcast inside `runAttempt`
    // on `turn_complete`, so this is a safety net rather than a duplicate
    // in normal production flow.
    broadcast(`session:${ctx.id}`, {
      type: 'run_status',
      sessionId: ctx.id,
      status: 'finished',
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    persistMessage({
      sessionId: ctx.id,
      planItemId: initialPlanItemId,
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
