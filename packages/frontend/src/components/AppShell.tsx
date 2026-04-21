import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Settings } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api } from '../api/client.js';
import { SettingsModal } from './SettingsModal.js';
import { DirectoryPicker } from './DirectoryPicker.js';

interface ShellHelpers {
  onProjectRenamed: (project: Project) => void;
}

interface Props {
  children: (project: Project | null, helpers: ShellHelpers) => React.ReactNode;
}

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'project';
}

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [picking, setPicking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;

  async function handleDirectoryChosen(cwd: string) {
    setError(null);
    try {
      const name = basenameOfPath(cwd);
      const created = await api.createProject({ name, cwd });
      setProjects((prev) => [created, ...prev]);
      setPicking(false);
      navigate(`/projects/${created.id}`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
        <div className="px-3 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold tracking-wide">pinloom</div>
          <button
            onClick={() => setPicking(true)}
            title="New project — pick a directory"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <Plus size={16} />
          </button>
        </div>

        {error && (
          <p className="px-3 pb-2 text-[11px] text-red-400 border-b border-[var(--color-border)]">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-auto py-2 flex flex-col gap-1">
          {projects.map((p) => {
            const active = p.id === projectId;
            return (
              <button
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className={`mx-2 rounded px-2 py-1.5 text-left text-sm flex flex-col gap-0.5 ${
                  active
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]/60'
                }`}
              >
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate text-[10px] opacity-70 font-mono">{p.cwd}</span>
              </button>
            );
          })}
          {projects.length === 0 && (
            <p className="px-3 text-xs text-[var(--color-ink-muted)]">
              Click + to pick a directory for your first project.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] p-2">
          <button
            onClick={() => setShowSettings(true)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] flex items-center gap-1.5"
          >
            <Settings size={12} />
            Settings
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        {children(activeProject, {
          onProjectRenamed: (updated) => {
            setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          },
        })}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {picking && (
        <DirectoryPicker
          onSelect={handleDirectoryChosen}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
