import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { SWRConfig, mutate } from 'swr';
import { AppShell } from './components/AppShell.js';
import { NotificationCenter } from './components/NotificationCenter.js';
import { GithubLink } from './components/GithubLink.js';
import { NotepadToggle, NotepadPanel } from './components/Notepad.js';
import { ChatDoneNotifier } from './components/ChatDoneNotifier.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { PinsPage } from './pages/PinsPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { TeamsPage } from './pages/TeamsPage.js';
import { TeamCanvasPage } from './pages/TeamCanvasPage.js';
import { WikiPage } from './pages/WikiPage.js';
import { WikiDetailPage } from './pages/WikiDetailPage.js';
import { cacheKeys } from './api/cacheKeys.js';

// SWR defaults: revalidate on browser focus + network reconnect so a tab
// that's been backgrounded snaps to fresh server state, dedupingInterval
// caps the burst when many keyed queries are mounted on the same view.
// focusThrottleInterval throttles the per-focus revalidate so rapid
// tab-flipping doesn't fan-out N keys × every focus into a fresh herd
// against the synchronous better-sqlite3 backend.
const swrConfig = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 2000,
  focusThrottleInterval: 5000,
};

export function App() {
  const [notepadOpen, setNotepadOpen] = useState(false);
  // Central listener for the `pinloom:teams-changed` window event.
  // SessionTabs / ChatView / TeamsPage all used to attach their own
  // listener and re-fetch teams + sessions raw — N×3 calls per mutation.
  // Now one listener invalidates the shared SWR keys, so every subscriber
  // gets the fresh data from a single deduped fetch.
  useEffect(() => {
    function onTeamsChanged() {
      void mutate(cacheKeys.teams());
      void mutate(cacheKeys.allSessions());
    }
    window.addEventListener('pinloom:teams-changed', onTeamsChanged);
    return () =>
      window.removeEventListener('pinloom:teams-changed', onTeamsChanged);
  }, []);
  return (
    <SWRConfig value={swrConfig}>
      <ChatDoneNotifier />
      <div className="flex h-screen overflow-hidden">
        {/* Content column. The top-right control cluster is positioned
            relative to this column (not the viewport) so it tracks the
            content edge and never overlaps the docked notepad. */}
        <div className="relative flex-1 min-w-0">
          <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
            <GithubLink />
            <NotepadToggle
              open={notepadOpen}
              onToggle={() => setNotepadOpen((v) => !v)}
            />
            <NotificationCenter />
          </div>
          <Routes>
            <Route path="/pins/:sessionId" element={<PinsPage />} />
            <Route path="/s/:sessionId" element={<SessionPage />} />
            <Route
              path="/projects/:projectId"
              element={
                <AppShell>
                  {(project, { onProjectRenamed }) =>
                    project ? (
                      <ProjectPage project={project} onRenamed={onProjectRenamed} />
                    ) : (
                      <div className="p-6 text-sm">Loading…</div>
                    )
                  }
                </AppShell>
              }
            />
            <Route
              path="/teams"
              element={
                <AppShell>
                  {() => <TeamsPage />}
                </AppShell>
              }
            />
            <Route
              path="/teams/:teamId"
              element={
                <AppShell>
                  {() => <TeamCanvasPage />}
                </AppShell>
              }
            />
            <Route
              path="/wiki/*"
              element={
                <AppShell>
                  {() => <WikiDetailPage />}
                </AppShell>
              }
            />
            <Route
              path="/wiki"
              element={
                <AppShell>
                  {() => <WikiPage />}
                </AppShell>
              }
            />
            <Route
              path="*"
              element={
                <AppShell>
                  {() => (
                    <div className="p-8 text-sm text-[var(--color-ink-muted)]">
                      Select a project from the sidebar or click <strong>+</strong> to create one.
                    </div>
                  )}
                </AppShell>
              }
            />
          </Routes>
        </div>
        {notepadOpen && <NotepadPanel onClose={() => setNotepadOpen(false)} />}
      </div>
    </SWRConfig>
  );
}
