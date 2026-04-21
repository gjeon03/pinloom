import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Settings, FolderOpen } from 'lucide-react';
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

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [picking, setPicking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createProject({ name, cwd });
      setProjects((prev) => [created, ...prev]);
      setName('');
      setCwd('');
      setAdding(false);
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
            onClick={() => setAdding((v) => !v)}
            title="New project"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <Plus size={16} />
          </button>
        </div>

        {adding && (
          <form
            onSubmit={addProject}
            className="px-3 pb-3 flex flex-col gap-1.5 border-b border-[var(--color-border)]"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-1 text-xs font-mono text-left hover:border-[var(--color-accent)] truncate flex items-center gap-1.5"
              title={cwd || 'Click to choose'}
            >
              <FolderOpen size={12} className="shrink-0 text-[var(--color-ink-muted)]" />
              <span className="truncate">{cwd || 'Choose directory…'}</span>
            </button>
            <div className="flex gap-1">
              <button
                type="submit"
                disabled={!name.trim() || !cwd.trim()}
                className="flex-1 rounded bg-[var(--color-accent)] text-black px-2 py-1 text-xs disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
            {error && <p className="text-red-400 text-[11px]">{error}</p>}
          </form>
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
          {projects.length === 0 && !adding && (
            <p className="px-3 text-xs text-[var(--color-ink-muted)]">
              Click + to add your first project.
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
          initialPath={cwd || undefined}
          onSelect={(p) => {
            setCwd(p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
