export interface Project {
  id: string;
  name: string;
  cwd: string;
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

export interface Session {
  id: string;
  projectId: string;
  planId: string | null;
  claudeSessionId: string | null;
  title: string | null;
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
  createdAt: string;
}

export interface HealthResponse {
  status: 'ok';
  cli: {
    installed: boolean;
    version: string | null;
  };
}


export type WsEvent =
  | { type: 'message'; sessionId: string; message: Message }
  | { type: 'message_updated'; sessionId: string; message: Message }
  | { type: 'stream_chunk'; sessionId: string; messageId: string; chunk: string }
  | { type: 'stream_end'; sessionId: string; messageId: string }
  | { type: 'plan_item_updated'; planId: string; item: PlanItem }
  | { type: 'run_log'; sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'run_status'; sessionId: string; status: 'started' | 'finished' | 'error'; error?: string };
