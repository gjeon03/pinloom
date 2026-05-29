// The session whose chat is currently visible in the foreground (set by
// ProjectPage). The chat-done notifier reads this at event time to suppress
// a notification for the session you're already looking at — imperative
// module state, intentionally not reactive.
let activeSessionId: string | null = null;

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}
