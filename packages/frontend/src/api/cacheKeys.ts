// SWR cache key factories. Centralizing them lets WS handlers invalidate
// the matching query (via `mutate(key)`) without hardcoding URL strings,
// and keeps the key shape consistent with the fetcher functions in
// hooks/useSessionData.ts.
export const cacheKeys = {
  sessionMessages: (sessionId: string) =>
    ['session-messages', sessionId] as const,
  sessionQueue: (sessionId: string) =>
    ['session-queue', sessionId] as const,
  sessionPins: (sessionId: string) => ['session-pins', sessionId] as const,
  runStatus: (sessionId: string) => ['run-status', sessionId] as const,
  // Cross-page lookups. Centralized so any component fetching them shares
  // SWR's deduped inflight + window-focus revalidation, instead of each
  // mount kicking off its own raw fetch (the thundering-herd cause of the
  // 1s+ latency burst when several ChatView/SessionTabs were mounted).
  //
  // TODO: migrate the remaining raw callers to these keys so they share
  // the dedup window — SessionPickerModal, TeamsPage, TeamCanvasPage,
  // SessionTabs's worker-picker (~line 1248), AppShell's project list.
  teams: () => ['teams'] as const,
  allSessions: () => ['sessions-all'] as const,
  projects: () => ['projects'] as const,
  search: (query: string, projectId: string | null) =>
    ['search', query, projectId] as const,
  promptTemplates: () => ['prompt-templates'] as const,
  wikiProposals: (status: string | null) =>
    ['wiki-proposals', status] as const,
  wikiProposalDiff: (id: string) => ['wiki-proposal-diff', id] as const,
};
