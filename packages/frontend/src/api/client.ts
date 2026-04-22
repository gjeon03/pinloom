import type {
  HealthResponse,
  Message,
  Plan,
  PlanItem,
  Project,
  Session,
} from '@pinloom/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface BrowseEntry {
  name: string;
  isDir: boolean;
  hidden: boolean;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  browseDir: (path?: string, showHidden = false) => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (showHidden) params.set('showHidden', 'true');
    return request<BrowseResponse>(`/api/fs/browse?${params}`);
  },
  homeDir: () => request<{ home: string }>('/api/fs/home'),

  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (body: { name: string; cwd: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  reorderProjects: (ids: string[]) =>
    request<Project[]>('/api/projects/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  listPlans: (projectId: string) =>
    request<Plan[]>(`/api/projects/${projectId}/plans`),
  createPlan: (projectId: string, body: { title: string }) =>
    request<Plan>(`/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listPlanItems: (planId: string) =>
    request<PlanItem[]>(`/api/plans/${planId}/items`),
  createPlanItem: (
    planId: string,
    body: { title: string; body?: string; parentId?: string | null },
  ) =>
    request<PlanItem>(`/api/plans/${planId}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePlanItem: (
    itemId: string,
    body: Partial<Pick<PlanItem, 'title' | 'body' | 'status' | 'orderIndex'>>,
  ) =>
    request<PlanItem>(`/api/plan-items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  listSessions: (projectId: string) =>
    request<Session[]>(`/api/projects/${projectId}/sessions`),
  createSession: (
    projectId: string,
    body: { planId?: string | null; title?: string | null },
  ) =>
    request<Session>(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listMessages: (sessionId: string) =>
    request<Message[]>(`/api/sessions/${sessionId}/messages`),
  sendMessage: (
    sessionId: string,
    body: { content: string; planItemId?: string | null },
  ) =>
    request<Message>(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  execShell: (sessionId: string, command: string) =>
    request<{ userMessage: Message; toolMessage: Message }>(
      `/api/sessions/${sessionId}/exec`,
      {
        method: 'POST',
        body: JSON.stringify({ command }),
      },
    ),
  cancelRun: (sessionId: string) =>
    request<{ cancelled: boolean; ai: boolean; exec: boolean }>(
      `/api/sessions/${sessionId}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  getRunStatus: (sessionId: string) =>
    request<{ running: boolean; ai: boolean; exec: boolean }>(
      `/api/sessions/${sessionId}/run-status`,
    ),

  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  renameSession: (sessionId: string, title: string | null) =>
    request<Session>(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  reorderSessions: (projectId: string, ids: string[]) =>
    request<Session[]>(`/api/projects/${projectId}/sessions/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  listPins: (sessionId: string) =>
    request<Message[]>(`/api/sessions/${sessionId}/pins`),
  handoffSession: (sessionId: string) =>
    request<Session>(`/api/sessions/${sessionId}/handoff`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  injectPin: (targetSessionId: string, pinMessageId: string) =>
    request<{ sessionId: string; message: Message }>(
      `/api/sessions/${targetSessionId}/inject-pin`,
      {
        method: 'POST',
        body: JSON.stringify({ pinMessageId }),
      },
    ),
  updateMessage: (
    messageId: string,
    body: { pinned?: boolean; pinTitle?: string | null },
  ) =>
    request<Message>(`/api/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};
