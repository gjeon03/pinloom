import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@planloom/shared';
import { api } from '../api/client.js';

export function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const p = await api.createProject({ name, cwd });
      setProjects((prev) => [p, ...prev]);
      setName('');
      setCwd('');
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold mb-4">Projects</h1>

      <form
        onSubmit={createProject}
        className="mb-6 flex gap-2 text-sm"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          className="flex-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1.5"
        />
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Absolute path (cwd)"
          className="flex-[2] rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1.5 font-mono"
        />
        <button
          type="submit"
          disabled={!name || !cwd}
          className="rounded bg-[var(--color-accent)] text-black px-3 py-1.5 disabled:opacity-40"
        >
          Add
        </button>
      </form>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <ul className="flex flex-col gap-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              to={`/projects/${p.id}`}
              className="block rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 hover:border-[var(--color-accent)]"
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-[var(--color-ink-muted)] font-mono">{p.cwd}</div>
            </Link>
          </li>
        ))}
        {projects.length === 0 && (
          <li className="text-sm text-[var(--color-ink-muted)]">No projects yet.</li>
        )}
      </ul>
    </div>
  );
}
