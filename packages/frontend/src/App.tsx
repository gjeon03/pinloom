import { useEffect, useRef, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { SWRConfig, mutate } from 'swr';
import { FileText, Search } from 'lucide-react';
import { AppShell } from './components/AppShell.js';
import { FeatureRoute } from './components/FeatureRoute.js';
import { FirstRunChooser } from './components/FirstRunChooser.js';
import { useFeatures } from './stores/uiConfig.js';
import { useT } from './i18n/t.js';
import { NotificationCenter } from './components/NotificationCenter.js';
import { GlobalSearchModal } from './components/GlobalSearchModal.js';
import { PromptTemplatesPanel } from './components/PromptTemplatesPanel.js';
import { Tooltip } from './components/Tooltip.js';
import { BotLauncher } from './components/BotLauncher.js';
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
import { TimelinePage } from './pages/TimelinePage.js';
import { RecapPage } from './pages/RecapPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
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
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const features = useFeatures();
  const t = useT();
  // Ref so the stable keydown handler always sees the latest flags.
  const featuresRef = useRef(features);
  featuresRef.current = features;

  // Global ⌘K / Ctrl+K opens history search from anywhere (when enabled).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!featuresRef.current.globalSearch) return;
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
          <div className="titlebar-no-drag absolute top-3 right-3 z-40 flex items-center gap-1.5">
            {features.globalSearch && (
            <Tooltip label={t('app.search')}>
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label={t('app.search')}
                className="inline-flex items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
              >
                <Search size={16} />
              </button>
            </Tooltip>
            )}
            {features.templates && (
            <Tooltip label={t('app.templates')}>
              <button
                type="button"
                onClick={() => setTemplatesOpen(true)}
                aria-label={t('app.templates')}
                className="inline-flex items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
              >
                <FileText size={16} />
              </button>
            </Tooltip>
            )}
            {(features.scheduleBot || features.skillBot) && <BotLauncher />}
            {features.notepad && (
            <NotepadToggle
              open={notepadOpen}
              onToggle={() => setNotepadOpen((v) => !v)}
            />
            )}
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
                <FeatureRoute flag="teams">
                  <AppShell>{() => <TeamsPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/skills"
              element={
                <FeatureRoute flag="skillBot">
                  <AppShell>{() => <SkillsPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/teams/:teamId"
              element={
                <FeatureRoute flag="teams">
                  <AppShell>{() => <TeamCanvasPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/wiki/proposals"
              element={
                <FeatureRoute flag="wiki">
                  <AppShell>{() => <WikiProposalsPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/wiki/*"
              element={
                <FeatureRoute flag="wiki">
                  <AppShell>{() => <WikiDetailPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/wiki"
              element={
                <FeatureRoute flag="wiki">
                  <AppShell>{() => <WikiPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/timeline"
              element={
                <FeatureRoute flag="timeline">
                  <AppShell>{() => <TimelinePage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="/recap"
              element={
                <FeatureRoute flag="recap">
                  <AppShell>{() => <RecapPage />}</AppShell>
                </FeatureRoute>
              }
            />
            <Route
              path="*"
              element={
                <AppShell>
                  {() => (
                    <div className="p-8 text-sm text-[var(--color-ink-muted)]">
                      {t('app.home')}
                    </div>
                  )}
                </AppShell>
              }
            />
          </Routes>
          </div>
          {templatesOpen && features.templates && (
            <PromptTemplatesPanel onClose={() => setTemplatesOpen(false)} />
          )}
          {notepadOpen && features.notepad && (
            <NotepadPanel onClose={() => setNotepadOpen(false)} />
          )}
        </div>
      </div>
      {searchOpen && features.globalSearch && (
        <GlobalSearchModal onClose={() => setSearchOpen(false)} />
      )}
      <FirstRunChooser />
    </SWRConfig>
  );
}
