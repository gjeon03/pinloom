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
};
