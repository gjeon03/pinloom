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

export type AgentKind = 'claude' | 'codex';

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

export interface HealthResponse {
  status: 'ok';
  agents: {
    claude: { installed: boolean; version: string | null };
    codex: { installed: boolean; version: string | null };
  };
}


export type WsEvent =
  | { type: 'message'; sessionId: string; message: Message }
  | { type: 'message_updated'; sessionId: string; message: Message }
  | { type: 'stream_chunk'; sessionId: string; messageId: string; chunk: string }
  | { type: 'stream_end'; sessionId: string; messageId: string }
  | { type: 'thinking_start'; sessionId: string }
  | { type: 'thinking_chunk'; sessionId: string; chunk: string }
  | { type: 'plan_item_updated'; planId: string; item: PlanItem }
  | { type: 'run_log'; sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'run_status'; sessionId: string; status: 'started' | 'finished' | 'error'; error?: string };
