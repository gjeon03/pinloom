import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { SWRConfig, mutate } from 'swr';
import { Search } from 'lucide-react';
import { AppShell } from './components/AppShell.js';
import { NotificationCenter } from './components/NotificationCenter.js';
import { GlobalSearchModal } from './components/GlobalSearchModal.js';
import { GithubLink } from './components/GithubLink.js';
import { NotepadToggle, NotepadPanel } from './components/Notepad.js';
import { ChatDoneNotifier } from './components/ChatDoneNotifier.js';
import { BackendStatusBanner } from './components/BackendStatusBanner.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { PinsPage } from './pages/PinsPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { TeamsPage } from './pages/TeamsPage.js';
import { TeamCanvasPage } from './pages/TeamCanvasPage.js';
import { WikiPage } from './pages/WikiPage.js';
import { WikiDetailPage } from './pages/WikiDetailPage.js';
import { WikiProposalsPage } from './pages/WikiProposalsPage.js';
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
  const [searchOpen, setSearchOpen] = useState(false);

  // Global ⌘K / Ctrl+K opens history search from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
      <div className="flex flex-col h-screen overflow-hidden">
        <BackendStatusBanner />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Content column. The top-right control cluster is positioned
              relative to this column (not the viewport) so it tracks the
              content edge and never overlaps the docked notepad. */}
          <div className="relative flex-1 min-w-0">
          <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Search history (⌘K)"
              aria-label="Search history"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
            >
              <Search size={16} />
            </button>
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
              path="/wiki/proposals"
              element={
                <AppShell>
                  {() => <WikiProposalsPage />}
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
      </div>
      {searchOpen && <GlobalSearchModal onClose={() => setSearchOpen(false)} />}
    </SWRConfig>
  );
}
