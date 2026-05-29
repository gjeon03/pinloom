export interface Project {
  id: string;
  name: string;
  cwd: string;
  groupId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = 'draft' | 'active' | 'archived';

export interface Plan {
  id: string;
  projectId: string;
  title: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export type PlanItemStatus = 'todo' | 'running' | 'done' | 'skipped' | 'blocked';

export interface PlanItem {
  id: string;
  planId: string;
  parentId: string | null;
  orderIndex: number;
  title: string;
  body: string;
  status: PlanItemStatus;
  createdAt: string;
  updatedAt: string;
}

// A project notepad lives as a tab alongside chat sessions. Its body is a
// split tree of text panes: a `split` node lays its children out in a row
// (side-by-side) or column (stacked), each child sized by a percentage; a
// `pane` leaf holds free-form text. Stored in the DB so it backs up with
// the rest of the project state.
export interface NotepadPaneNode {
  id: string;
  kind: 'pane';
  content: string;
}
export interface NotepadSplitNode {
  id: string;
  kind: 'split';
  dir: 'row' | 'column';
  sizes: number[];
  children: NotepadNode[];
}
export type NotepadNode = NotepadPaneNode | NotepadSplitNode;

export interface ProjectNotepad {
  id: string;
  projectId: string;
  name: string;
  root: NotepadNode;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// Body-less shape for the tab strip (the list endpoint omits `root`).
export interface ProjectNotepadSummary {
  id: string;
  projectId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentKind = 'claude' | 'codex';

// Reasoning effort levels per agent. Claude's underlying SDK supports an
// extra "max" tier that Codex doesn't expose; the picker UI filters the
// list based on session.agent so callers don't pick something the
// adapter can't honor.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Session {
  id: string;
  projectId: string;
  planId: string | null;
  agent: AgentKind;
  agentSessionId: string | null;
  /** @deprecated mirror of agentSessionId for legacy callers; will be removed. */
  claudeSessionId: string | null;
  title: string | null;
  nextImageNumber: number;
  lastSyncedMessageId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  planItemId: string | null;
  role: MessageRole;
  content: string;
  toolUse: string | null;
  pinned: boolean;
  pinTitle: string | null;
  pinnedAt: string | null;
  sourceMessageId: string | null;
  model: string | null;
  createdAt: string;
}

// User-managed environment variable. Stored locally in pinloom's SQLite and
// merged into the backend's process.env so every agent's Bash tool inherits
// it. The list endpoint omits `value` (replaced by `hasValue`) so masked
// values never round-trip through the wire when not needed.
export interface UserEnvVar {
  key: string;
  description: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserEnvVarWithValue extends UserEnvVar {
  value: string;
}

// One pending user message held by the backend until the agent reaches a
// turn boundary, then drained as a single combined prompt. The chat UI
// just renders these — it doesn't own the state.
export interface QueueItem {
  id: string;
  sessionId: string;
  content: string;
  model: string | null;
  createdAt: string;
}

// A team groups one orchestrator session with N worker sessions. The
// orchestrator addresses workers by `alias` via the pinloom MCP server.
// Workers keep their own systemPrompt / agent / model and remain usable
// as standalone sessions — team membership is purely additive.
export interface TeamMember {
  sessionId: string;
  alias: string;
  /**
   * Optional system-prompt-style instructions for this worker —
   * identity, guidelines, do/don'ts, output conventions, anything
   * else that should color every response. Injected verbatim into
   * the worker's systemPrompt at run time, and surfaced (truncated)
   * to the orchestrator so it knows when to route work to this
   * alias. Null = generalist worker (no extra prompt injection).
   */
  instructions: string | null;
  /**
   * Short, lowercase identifiers (e.g. "backend", "tests") used to
   * group workers. For now they're metadata — surfaced in the
   * orchestrator's team context and the canvas — and a future PR can
   * layer broadcast-by-tag dispatch on top without a schema change.
   */
  tags: string[];
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  /**
   * The session whose agent orchestrates this team. Required: a team is
   * unusable without an orchestrator since the MCP server attributes
   * dispatch calls to it. Deleting the orchestrator session cascades
   * the team away.
   */
  orchestratorSessionId: string;
  /**
   * Optional system-prompt-style briefing for the orchestrator —
   * "you are the PM of this crew, prefer X over Y, never auto-merge"
   * etc. Mirrors `TeamMember.instructions`. Null = no extra prompt
   * injection beyond the auto-generated team context block.
   */
  instructions: string | null;
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  status: 'ok';
  agents: {
    claude: { installed: boolean; version: string | null };
    codex: { installed: boolean; version: string | null };
  };
}


// Events emitted by the team-dispatch layer for the descriptive canvas
// (PR3). These are *observed* — pinloom doesn't author the dispatch
// graph, it just renders what the orchestrator agent does at runtime.
// Stored only in an in-memory ring buffer (services/team-events.ts) so
// late-joining clients can backfill via HTTP, then subscribe to live
// events via the `team:${teamId}` WS channel.
export type TeamDispatchEvent =
  // Orchestrator just enqueued a prompt to a worker. `previewText` is
  // a short snippet (first ~120 chars) so the canvas can label the edge
  // without fetching the full message.
  | {
      type: 'dispatch_send';
      teamId: string;
      alias: string;
      sessionId: string;
      previewText: string;
      at: string;
    }
  // Worker's runtime status changed — running / idle / queued. Drives
  // the node pulse on the canvas. Coalesces queue depth + isAiRunning
  // so the client doesn't have to combine three signals.
  | {
      type: 'worker_status';
      teamId: string;
      alias: string;
      sessionId: string;
      running: boolean;
      queued: number;
      at: string;
    };

export type WsEvent =
  | { type: 'message'; sessionId: string; message: Message }
  | { type: 'message_updated'; sessionId: string; message: Message }
  | { type: 'stream_chunk'; sessionId: string; messageId: string; chunk: string }
  | { type: 'stream_end'; sessionId: string; messageId: string }
  | { type: 'thinking_start'; sessionId: string }
  | { type: 'thinking_chunk'; sessionId: string; chunk: string }
  | { type: 'plan_item_updated'; planId: string; item: PlanItem }
  | { type: 'run_log'; sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }
  // Backend-owned message queue state. The chat UI mirrors this list; it
  // does not maintain its own copy. Broadcast on every enqueue, dequeue,
  // and drain (turn-boundary auto-drain).
  | { type: 'queue_updated'; sessionId: string; items: QueueItem[] }
  | { type: 'run_status'; sessionId: string; status: 'started' | 'finished' | 'error'; error?: string }
  // Live dispatch event for the team canvas. Channel: `team:${teamId}`.
  | { type: 'team_dispatch_event'; event: TeamDispatchEvent };
