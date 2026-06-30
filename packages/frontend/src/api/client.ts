import type {
  AgentKind,
  BotKind,
  HealthResponse,
  Message,
  MessageSearchResult,
  Plan,
  PlanItem,
  Project,
  PromptTemplate,
  WikiProposal,
  WikiProposalDiff,
  ProjectGroup,
  ProjectNotepad,
  ProjectNotepadSummary,
  NotepadNode,
  QueueItem,
  Session,
  Team,
  TeamDispatchEvent,
  TeamMember,
  UserEnvVar,
  UserEnvVarWithValue,
} from '@pinloom/shared';

// A cited source in a Recap answer — a past message OR a work-timeline entry.
export type RecapSource =
  | {
      kind: 'message';
      n: number;
      messageId: string;
      sessionId: string;
      sessionTitle: string | null;
      projectName: string;
      createdAt: string;
    }
  | { kind: 'timeline'; n: number; projectId: string; projectName: string; date: string }
  | { kind: 'wiki'; n: number; slug: string; title: string };

// A timeline entry hit from ⌘K search (semantic-only).
export interface TimelineSearchHit {
  projectId: string;
  projectName: string;
  date: string;
  excerpt: string;
}

// A wiki page hit from ⌘K search (semantic-only).
export interface WikiSearchHit {
  slug: string;
  title: string;
  excerpt: string;
}

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

export interface AutostartStatus {
  supported: boolean;
  platform: 'darwin' | 'linux' | 'unsupported';
  installed: boolean;
  registered: boolean;
  unitPath: string | null;
}

export interface AutostartActionResult {
  status: AutostartStatus;
  warnings: string[];
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

export type SkillScope = 'global' | 'project';
export type SkillOrigin = 'pinloom' | 'external' | 'local';
export interface SkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
  /** global only: whether the claude/codex symlinks point at our source. */
  linkedClaude?: boolean;
  linkedCodex?: boolean;
  /** global only: pinloom-managed / external symlink / local real dir. */
  origin?: SkillOrigin;
  hasClaude?: boolean;
  hasCodex?: boolean;
  /** global only: editable here (true only for pinloom-managed). */
  editable?: boolean;
  /** external only: where the symlink points (for display). */
  target?: string;
}
export interface SkillDetail extends SkillSummary {
  /** Editable SKILL.md body (everything after the frontmatter). */
  body: string;
  path: string;
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

  // Full-text search over conversation history (knowledge-system v2 Phase 1).
  search: (query: string, opts?: { projectId?: string; groupId?: string; limit?: number }) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.projectId) params.set('projectId', opts.projectId);
    if (opts?.groupId) params.set('groupId', opts.groupId);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return request<{
      results: MessageSearchResult[];
      timeline: TimelineSearchHit[];
      wiki: WikiSearchHit[];
    }>(`/api/search?${params}`);
  },

  // Reusable prompt templates (global, manually ordered).
  getEmbeddingsStatus: () =>
    request<{
      mode: 'in-process' | 'ollama' | 'off';
      ready: boolean;
      id: string | null;
      ollamaModel: string;
      ollama: { running: boolean; models: string[] };
      modelPresent: boolean;
      indexing: {
        messages: { indexed: number; total: number };
        timeline: { indexed: number };
        wiki: { indexed: number; total: number };
        lastError: { pass: string; message: string; at: string } | null;
      };
    }>('/api/settings/embeddings'),
  setEmbeddingsBackend: (mode: 'in-process' | 'ollama' | 'off', model?: string) =>
    request<{ mode: string; ready: boolean }>('/api/settings/embeddings', {
      method: 'POST',
      body: JSON.stringify({ mode, model }),
    }),
  pullOllamaModel: (model?: string) =>
    request<{ started: true; model: string }>('/api/settings/ollama/pull', {
      method: 'POST',
      body: JSON.stringify(model ? { model } : {}),
    }),
  ollamaPullStatus: () =>
    request<{
      pulling: boolean;
      model: string;
      status: string;
      completed: number;
      total: number;
      done: boolean;
      error: string | null;
    }>('/api/settings/ollama/pull'),

  listPromptTemplates: () =>
    request<PromptTemplate[]>('/api/prompt-templates'),
  createPromptTemplate: (body: { title: string; body: string }) =>
    request<PromptTemplate>('/api/prompt-templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePromptTemplate: (
    id: string,
    body: { title?: string; body?: string },
  ) =>
    request<PromptTemplate>(`/api/prompt-templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deletePromptTemplate: (id: string) =>
    request<{ ok: true }>(`/api/prompt-templates/${id}`, { method: 'DELETE' }),
  // Session timeline / handover doc: structured summary + day-by-day detail.
  getHandover: (sessionId: string) =>
    request<{ markdown: string | null; generatedAt: string | null; generating: boolean }>(
      `/api/sessions/${sessionId}/handover`,
    ),
  generateHandover: (
    sessionId: string,
    range?: { since?: string | null; until?: string | null },
  ) =>
    request<{ markdown: string; days: number; truncatedDays: number; generatedAt: string }>(
      `/api/sessions/${sessionId}/handover`,
      { method: 'POST', body: JSON.stringify(range ?? {}) },
    ),
  reorderPromptTemplates: (ids: string[]) =>
    request<PromptTemplate[]>('/api/prompt-templates/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // Wiki similarity graph (nodes = pages, edges = nearest neighbours by embedding).
  getWikiGraph: () =>
    request<{
      nodes: { id: string; title: string; group: string; groupId: string | null }[];
      edges: { source: string; target: string; weight: number }[];
      truncated: boolean;
    }>('/api/wiki/graph'),

  // Wiki gardener proposals (Phase 2).
  runGardener: () =>
    request<{
      created: number;
      skipped: number;
      truncated: boolean;
      duplicateCandidates?: number;
    }>('/api/wiki/garden', { method: 'POST' }),
  listWikiProposals: (status?: WikiProposal['status']) =>
    request<WikiProposal[]>(
      `/api/wiki/proposals${status ? `?status=${status}` : ''}`,
    ),
  getWikiProposalDiff: (id: string) =>
    request<WikiProposalDiff>(`/api/wiki/proposals/${id}`),
  acceptWikiProposal: (id: string) =>
    request<WikiProposal>(`/api/wiki/proposals/${id}/accept`, {
      method: 'POST',
    }),
  rejectWikiProposal: (id: string) =>
    request<WikiProposal>(`/api/wiki/proposals/${id}/reject`, {
      method: 'POST',
    }),

  // User profile (~/.pinloom/wiki/USER.md) — inlined into every system prompt.
  getUserProfile: () =>
    request<{ profile: string; maxChars: number }>('/api/user-profile'),
  setUserProfile: (profile: string) =>
    request<{ profile: string; maxChars: number }>('/api/user-profile', {
      method: 'PUT',
      body: JSON.stringify({ profile }),
    }),

  // Open (find-or-create) a built-in bot session and return it for navigation.
  openBot: (kind: BotKind) =>
    request<Session>(`/api/bots/${kind}/open`, { method: 'POST' }),
  // Reset a bot's singleton session (clear messages + resume token) so the next
  // request starts fresh without prior-context contamination.
  resetBot: (kind: BotKind) =>
    request<Session>(`/api/bots/${kind}/reset`, { method: 'POST' }),

  // ── Skills (management page) ──────────────────────────────────────────────
  listSkills: (scope: SkillScope, projectId?: string) =>
    request<SkillSummary[]>(
      `/api/skills?scope=${scope}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`,
    ),
  getSkill: (scope: SkillScope, name: string, projectId?: string) =>
    request<SkillDetail>(
      `/api/skills/${scope}/${encodeURIComponent(name)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`,
    ),
  saveSkill: (input: {
    name: string;
    scope: SkillScope;
    description: string;
    body: string;
    project?: string;
  }) => request<SkillDetail>(`/api/skills`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteSkill: (scope: SkillScope, name: string, projectId?: string) =>
    request<{ ok: true }>(
      `/api/skills/${scope}/${encodeURIComponent(name)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'DELETE' },
    ),
  relinkSkill: (name: string) =>
    request<{ links: { claude: string; codex: string } }>(
      `/api/skills/${encodeURIComponent(name)}/relink`,
      { method: 'POST' },
    ),

  // A session + its project in one call, resolving hidden-project (bot)
  // sessions that the project list omits.
  getSessionContext: (sessionId: string) =>
    request<{ session: Session; project: Project }>(
      `/api/sessions/${sessionId}/context`,
    ),

  // Corpus recap (Phase 4)
  recapAsk: (
    question: string,
    projectId?: string,
    language?: 'ko' | 'en',
    groupId?: string,
  ) =>
    request<{
      answer: string;
      sources: RecapSource[];
    }>('/api/recap/ask', {
      method: 'POST',
      body: JSON.stringify({ question, projectId, language, groupId }),
    }),
  recapGenerate: (body: {
    kind: 'detailed' | 'concise';
    dateFrom: string;
    dateTo: string;
    projectId?: string;
    language?: 'ko' | 'en';
  }) =>
    request<{ markdown: string; empty: boolean }>('/api/recap/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Work Timeline (L1)
  getTimelineIndex: () =>
    request<{
      projects: {
        projectId: string;
        projectName: string;
        groupId: string | null;
        auto: boolean;
        dates: string[];
      }[];
    }>('/api/timeline/index'),
  listTimelineDates: (projectId: string) =>
    request<{ dates: string[] }>(`/api/timeline/projects/${projectId}`),
  getTimelineEntry: (projectId: string, date: string) =>
    request<{ date: string; markdown: string | null }>(
      `/api/timeline/projects/${projectId}/entries/${date}`,
    ),
  saveTimelineEntry: (projectId: string, date: string, markdown: string) =>
    request<{ ok: true; date: string }>(
      `/api/timeline/projects/${projectId}/entries/${date}`,
      { method: 'PUT', body: JSON.stringify({ markdown }) },
    ),
  openTimelineInEditor: (projectId: string, date: string) =>
    request<{ ok: true; path: string }>(
      `/api/timeline/projects/${projectId}/entries/${date}/open`,
      { method: 'POST' },
    ),
  getTimelineForDate: (date: string) =>
    request<{
      date: string;
      entries: { slug: string; projectName: string; markdown: string }[];
    }>(`/api/timeline/date/${date}`),
  setProjectTimelineAuto: (projectId: string, auto: boolean) =>
    request<{ ok: true; auto: boolean }>(`/api/timeline/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto }),
    }),
  setProjectWikiAuto: (projectId: string, auto: boolean) =>
    request<{ ok: true; auto: boolean }>(`/api/wiki/projects/${projectId}/auto`, {
      method: 'PATCH',
      body: JSON.stringify({ auto }),
    }),
  captureTimeline: (projectId: string, date?: string) =>
    request<{ ok: true; date: string; written: boolean }>(
      `/api/timeline/projects/${projectId}/capture`,
      { method: 'POST', body: JSON.stringify(date ? { date } : {}) },
    ),
  captureTimelineAll: (date?: string) =>
    request<{ started: true; date: string; total: number }>('/api/timeline/capture-all', {
      method: 'POST',
      body: JSON.stringify(date ? { date } : {}),
    }),
  captureAllStatus: () =>
    request<{
      running: boolean;
      date: string;
      total: number;
      done: number;
      captured: number;
      failed: number;
      finishedAt: number | null;
    }>('/api/timeline/capture-all/status'),

  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (body: { name: string; cwd: string; groupId?: string | null }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  reorderProjects: (items: Array<{ id: string; groupId: string | null }>) =>
    request<Project[]>('/api/projects/reorder', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  listProjectGroups: () => request<ProjectGroup[]>('/api/project-groups'),
  createProjectGroup: (name: string) =>
    request<ProjectGroup>('/api/project-groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameProjectGroup: (id: string, name: string) =>
    request<ProjectGroup>(`/api/project-groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteProjectGroup: (id: string) =>
    request<{ ok: true }>(`/api/project-groups/${id}`, { method: 'DELETE' }),
  reorderProjectGroups: (ids: string[]) =>
    request<ProjectGroup[]>('/api/project-groups/reorder', {
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
    body: {
      planId?: string | null;
      title?: string | null;
      agent?: AgentKind;
    },
  ) =>
    request<Session>(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  moveSession: (sessionId: string, targetProjectId: string) =>
    request<{ session: Session; sourceFiller: Session | null }>(
      `/api/sessions/${sessionId}/move`,
      {
        method: 'POST',
        body: JSON.stringify({ projectId: targetProjectId }),
      },
    ),
  listMessages: (sessionId: string) =>
    request<Message[]>(`/api/sessions/${sessionId}/messages`),
  sendMessage: (
    sessionId: string,
    body: {
      content: string;
      planItemId?: string | null;
      images?: Array<{ mimeType: string; base64: string }>;
      model?: string;
    },
  ) =>
    request<Message>(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendMessages: (
    sessionId: string,
    body: {
      messages: Array<{
        content: string;
        planItemId?: string | null;
        images?: Array<{ mimeType: string; base64: string }>;
      }>;
      model?: string;
      // When true the backend silently aborts any in-flight run before
      // starting a new one with these messages — used by the chat UI's
      // mid-task queue drain.
      interrupt?: boolean;
    },
  ) =>
    request<Message[]>(`/api/sessions/${sessionId}/messages/batch`, {
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
  updateSession: (
    sessionId: string,
    body: { model?: string | null; reasoningEffort?: string | null },
  ) =>
    request<Session>(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  reorderSessions: (projectId: string, ids: string[]) =>
    request<Session[]>(`/api/projects/${projectId}/sessions/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  convertSessionTransport: (sessionId: string, transport: 'sdk' | 'terminal') =>
    request<{ session: Session; resumeCarried: boolean }>(
      `/api/sessions/${sessionId}/transport`,
      {
        method: 'POST',
        body: JSON.stringify({ transport }),
      },
    ),
  getDefaultTransport: () =>
    request<{ setting: 'sdk' | 'terminal' | null; effective: string }>(
      '/api/settings/default-transport',
    ),
  setDefaultTransport: (transport: 'sdk' | 'terminal' | null) =>
    request<{ setting: 'sdk' | 'terminal' | null; effective: string }>(
      '/api/settings/default-transport',
      { method: 'PUT', body: JSON.stringify({ transport }) },
    ),

  getAutostart: () => request<AutostartStatus>('/api/settings/autostart'),
  enableAutostart: () =>
    request<AutostartActionResult>('/api/settings/autostart', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  disableAutostart: () =>
    request<AutostartActionResult>('/api/settings/autostart', {
      method: 'DELETE',
    }),
  autostartUnitUrl: () => '/api/settings/autostart/unit',

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
  syncWiki: (sessionId: string, body?: { model?: string }) =>
    request<{
      staged: number;
      skipped?: number;
      batchId?: string;
      messageCount: number;
      syncedThroughMessageId?: string | null;
    }>(`/api/sessions/${sessionId}/wiki-sync`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  updateMessage: (
    messageId: string,
    body: { pinned?: boolean; pinTitle?: string | null },
  ) =>
    request<Message>(`/api/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  // Where did this message originally live? Used by injected-pin
  // cards to render a 'jump to original session' link.
  getMessageSource: (messageId: string) =>
    request<{
      messageId: string;
      sessionId: string;
      sessionTitle: string | null;
      projectId: string;
      projectName: string;
    }>(`/api/messages/${messageId}/source`),

  // Wiki dashboard.
  wikiOverview: () => request<WikiOverview>('/api/wiki/overview'),
  wikiPage: (filename: string) =>
    request<WikiPage>(`/api/wiki/pages/${encodeURI(filename)}`),
  updateWikiPage: (
    filename: string,
    body: {
      meta: {
        appliesTo: string[];
        topic: string[];
        related: string[];
        summary: string;
      };
      body: string;
    },
  ) =>
    request<WikiPage>(`/api/wiki/pages/${encodeURI(filename)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  wikiOpenInEditor: (filename: string) =>
    request<{ ok: true; path: string }>('/api/wiki/open', {
      method: 'POST',
      body: JSON.stringify({ filename }),
    }),
  wikiOpenFolder: () =>
    request<{ ok: true; path: string }>('/api/wiki/open-folder', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  wikiSyncCandidates: () =>
    request<WikiSyncCandidate[]>('/api/wiki/sync-candidates'),
  wikiAnalyze: (body: {
    projectId: string;
    dimension?: string;
    model?: string;
    startedAt?: string;
  }) =>
    request<WikiAnalyzeResult>('/api/wiki/analyze', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  wikiAnalysesStatus: () =>
    request<WikiAnalysesStatusResponse>('/api/wiki/analyses/status'),

  // Wiki archive — export streams a zip; import expects base64 (server
  // creates a backup before mutating the wiki tree).
  wikiExport: async (): Promise<Blob> => {
    const res = await fetch('/api/wiki/export');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.blob();
  },
  wikiImport: (body: { mode: 'skip' | 'overwrite'; dataBase64: string }) =>
    request<WikiImportSummary>('/api/wiki/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Pending message queue (backend-owned). The chat UI mirrors WS
  // broadcasts; this HTTP path is only for initial load + manual remove.
  listQueue: (sessionId: string) =>
    request<QueueItem[]>(`/api/sessions/${sessionId}/queue`),
  enqueueMessage: (
    sessionId: string,
    body: { content: string; model?: string | null },
  ) =>
    request<QueueItem>(`/api/sessions/${sessionId}/queue`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeQueueItem: (sessionId: string, itemId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}/queue/${itemId}`, {
      method: 'DELETE',
    }),
  clearQueue: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}/queue`, {
      method: 'DELETE',
    }),

  // User-managed environment variables (Settings → Environment Variables).
  listEnvVars: () => request<UserEnvVar[]>('/api/settings/env'),
  getEnvVar: (key: string) =>
    request<UserEnvVarWithValue>(`/api/settings/env/${encodeURIComponent(key)}`),
  upsertEnvVar: (
    key: string,
    body: { value: string; description?: string | null; isSecret?: boolean },
  ) =>
    request<UserEnvVar>(`/api/settings/env/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteEnvVar: (key: string) =>
    request<{ ok: true }>(`/api/settings/env/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  // GitHub backup — Phase A: token + repo configuration. Sync / restore
  // endpoints land in subsequent phases.
  getBackupConfig: () =>
    request<{
      connected: boolean;
      user: { login: string } | null;
      repo: { fullName: string; cloneUrl: string } | null;
      lastSyncAt: string | null;
    }>('/api/settings/backup'),
  setBackupToken: (token: string) =>
    request<{
      connected: boolean;
      user: { login: string } | null;
      repo: { fullName: string; cloneUrl: string } | null;
      lastSyncAt: string | null;
    }>('/api/settings/backup/token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),
  clearBackupToken: () =>
    request<{ connected: boolean; user: null; repo: null; lastSyncAt: null }>(
      '/api/settings/backup/token',
      { method: 'DELETE' },
    ),
  listBackupRepos: () =>
    request<
      Array<{
        fullName: string;
        name: string;
        private: boolean;
        cloneUrl: string;
        defaultBranch: string;
        updatedAt: string;
      }>
    >('/api/settings/backup/repos'),
  setBackupRepo: (
    body:
      | { mode: 'select'; fullName: string; cloneUrl: string }
      | { mode: 'create'; name: string; private?: boolean },
  ) =>
    request<{
      connected: boolean;
      user: { login: string } | null;
      repo: { fullName: string; cloneUrl: string } | null;
      lastSyncAt: string | null;
    }>('/api/settings/backup/repo', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Wiki sync — pushes the local wiki tree to the connected GitHub repo.
  runBackupSync: () =>
    request<{
      exported: { wikiBytes: number; exportedAt: string };
      committed: boolean;
      pushed: boolean;
      message: string;
    }>('/api/backup/sync', { method: 'POST' }),
  runBackupRestore: () =>
    request<{
      imported: { wikiFilesImported: number; wikiFilesSkipped: number };
      fromCommit: string | null;
    }>('/api/backup/restore', { method: 'POST' }),

  // Database file export/import — decoupled from the GitHub repo.
  // exportDb triggers a file download via window.location; the response
  // doesn't need typing because it's not consumed via fetch.
  exportDbUrl: () => '/api/backup/db/export',
  importDb: (file: string) =>
    request<{
      projectsImported: number;
      projectsSkipped: number;
      sessionsImported: number;
      sessionsSkipped: number;
      messagesImported: number;
    }>('/api/backup/db/import', {
      method: 'POST',
      body: JSON.stringify({ file }),
    }),

  // Cross-project session list — used by Teams UI to populate pickers
  // without an N+1 fetch per project.
  listAllSessions: () => request<Session[]>('/api/sessions'),

  // Teams — orchestrator + worker grouping. PR1 ships CRUD only;
  // dispatch primitives (team_send / team_read / …) land in PR2.
  listTeams: () => request<Team[]>('/api/teams'),
  getTeam: (id: string) => request<Team>(`/api/teams/${id}`),
  createTeam: (body: {
    name: string;
    orchestratorSessionId: string;
    instructions?: string | null;
  }) =>
    request<Team>('/api/teams', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTeam: (
    id: string,
    body: {
      name?: string;
      orchestratorSessionId?: string;
      // Pass null to clear; omit to leave unchanged.
      instructions?: string | null;
    },
  ) =>
    request<Team>(`/api/teams/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteTeam: (id: string) =>
    request<{ ok: true }>(`/api/teams/${id}`, { method: 'DELETE' }),
  addTeamMember: (
    id: string,
    body: {
      sessionId: string;
      alias: string;
      instructions?: string | null;
      tags?: string[];
    },
  ) =>
    request<TeamMember>(`/api/teams/${id}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTeamMember: (
    id: string,
    sessionId: string,
    body: {
      alias?: string;
      // Pass null to clear; omit to leave unchanged.
      instructions?: string | null;
      tags?: string[];
    },
  ) =>
    request<TeamMember>(
      `/api/teams/${id}/members/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  removeTeamMember: (id: string, sessionId: string) =>
    request<{ ok: true }>(
      `/api/teams/${id}/members/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),

  // Backfill for the descriptive team-dispatch canvas. Returns recent
  // events from the in-memory ring buffer; subscribe to the live stream
  // via the `team:${teamId}` WS channel to get incremental updates.
  listTeamDispatchEvents: (teamId: string, limit = 100) =>
    request<TeamDispatchEvent[]>(
      `/api/teams/${teamId}/dispatch/events?limit=${limit}`,
    ),

  // Global scratchpad (single shared note, stored in app_settings as a
  // structured doc: tabs of vertically-split text panes).
  getNotepad: () => request<{ doc: NotepadDoc }>('/api/notepad'),
  saveNotepad: (doc: NotepadDoc) =>
    request<{ ok: true }>('/api/notepad', {
      method: 'PUT',
      body: JSON.stringify({ doc }),
    }),
};

// Per-project notepads (tabs alongside chat sessions). List returns
// summaries (no body); open/patch carry the full split-tree `root`.
export const projectNotepadApi = {
  list: (projectId: string) =>
    request<ProjectNotepadSummary[]>(`/api/projects/${projectId}/notepads`),
  create: (projectId: string, name?: string) =>
    request<ProjectNotepad>(`/api/projects/${projectId}/notepads`, {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),
  get: (id: string) => request<ProjectNotepad>(`/api/notepads/${id}`),
  update: (id: string, patch: { name?: string; root?: NotepadNode }) =>
    request<ProjectNotepad>(`/api/notepads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<{ ok: true }>(`/api/notepads/${id}`, { method: 'DELETE' }),
};

export interface NotepadPane {
  id: string;
  content: string;
  height: number;
}
export interface NotepadTab {
  id: string;
  name: string;
  panes: NotepadPane[];
}
export interface NotepadDoc {
  tabs: NotepadTab[];
  activeTabId: string;
}

export interface WikiImportSummary {
  mode: 'skip' | 'overwrite';
  added: string[];
  overwritten: string[];
  skipped: string[];
  backupPath: string;
}

export interface WikiAnalyzeResult {
  output: string;
  pageFile: string;
  pageRelPath: string;
  pageWritten: boolean;
  charCount: number;
}

export interface WikiAnalysisLogEntry {
  projectId: string;
  projectName: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'error';
  detail?: string;
  pageRelPath?: string;
}

export interface WikiAnalysesStatusResponse {
  running: WikiAnalysisLogEntry[];
  recent: WikiAnalysisLogEntry[];
}

export interface WikiFrontmatter {
  appliesTo: string[];
  topic: string[];
  related: string[];
  summary: string;
}

export interface WikiPage {
  filename: string;
  relPath: string;
  title: string;
  meta: WikiFrontmatter;
  body: string;
  rawBody: string;
  isPromotedDir: boolean;
}

export interface WikiOverview {
  pages: WikiPage[];
  index: string | null;
  schema: string | null;
  wikiRoot: string;
}

export interface WikiSyncCandidate {
  id: string;
  projectId: string;
  projectName: string | null;
  projectCwd: string;
  projectBasename: string;
  title: string | null;
  lastSyncedMessageId: string | null;
  unsyncedCount: number;
  createdAt: string;
  updatedAt: string;
}
