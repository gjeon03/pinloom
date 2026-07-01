import type { NavigateFunction } from 'react-router-dom';

// Open a session in its PROJECT view (sidebar + session tabs) rather than the
// standalone /s/:id page. Seed the project's last-session marker and clear the
// other "active view" markers (canvas / notepad / plan) so the project lands
// on the session, then route there. Also fires goto-session for the
// already-mounted same-project case (the page switches the tab in place).
export function gotoSessionTab(
  navigate: NavigateFunction,
  projectId: string,
  sessionId: string,
  // Optional: a specific message to scroll to + highlight once the session's
  // chat mounts (search "jump to that message"). Delivered via the event (for
  // the already-mounted same-session case) AND a localStorage marker (fresh
  // navigate — ChatView reads it on mount).
  messageId?: string,
): void {
  try {
    localStorage.setItem(`pinloom:lastSession:${projectId}`, sessionId);
    localStorage.removeItem(`pinloom:lastCanvas:${projectId}`);
    localStorage.removeItem(`pinloom:lastNotepad:${projectId}`);
    localStorage.removeItem(`pinloom:planActive:${projectId}`);
    if (messageId) localStorage.setItem(`pinloom:focusMessage:${sessionId}`, messageId);
  } catch {
    // localStorage unavailable — the goto-session event still covers the
    // same-project case below.
  }
  window.dispatchEvent(
    new CustomEvent('pinloom:goto-session', {
      detail: { projectId, sessionId, messageId },
    }),
  );
  navigate(`/projects/${projectId}`);
}
