import type {
  HealthResponse,
  Message,
  Plan,
  PlanItem,
  Project,
  Session,
} from '@pinloom/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (body: { name: string; cwd: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

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
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  renameSession: (sessionId: string, title: string | null) =>
    request<Session>(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  listPins: (sessionId: string) =>
    request<Message[]>(`/api/sessions/${sessionId}/pins`),
  updateMessage: (
    messageId: string,
    body: { pinned?: boolean; pinTitle?: string | null },
  ) =>
    request<Message>(`/api/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};
