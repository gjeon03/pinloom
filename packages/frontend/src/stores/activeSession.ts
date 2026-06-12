// Which sessions the user can currently SEE (set by ProjectPage). The
// chat-done notifier reads this at event time to suppress a notification for
// a chat that's already on screen — imperative module state, intentionally
// not reactive.
//
// Two granularities:
//  - activeSessionId: the focused panel's session (drives pins rail etc.)
//  - visibleSessionIds: every session visible across dock splits — each
//    group's selected tab. A side-by-side worker you can watch shouldn't
//    buzz you any more than the focused one does.
let activeSessionId: string | null = null;
let visibleSessionIds: ReadonlySet<string> = new Set();

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function setVisibleSessionIds(ids: ReadonlySet<string>): void {
  visibleSessionIds = ids;
}

/** True if the session is on screen in ANY dock pane (or is the focused
 *  session — covers surfaces that only publish the single id). */
export function isSessionVisible(sessionId: string): boolean {
  return visibleSessionIds.has(sessionId) || activeSessionId === sessionId;
}
