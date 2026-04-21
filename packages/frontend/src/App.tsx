import { Routes, Route } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { PinsPage } from './pages/PinsPage.js';

export function App() {
  return (
    <Routes>
      <Route path="/pins/:sessionId" element={<PinsPage />} />
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
  );
}
