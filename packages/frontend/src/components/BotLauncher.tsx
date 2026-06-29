import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Wrench } from 'lucide-react';
import type { Project } from '@pinloom/shared';
import { api } from '../api/client.js';
import { Tooltip } from './Tooltip.js';
import { useFeatures } from '../stores/uiConfig.js';

// Seed the target session's composer draft (read by ChatView on mount) so the
// user lands with the scope already stated. Prepends, never clobbers.
function seedDraft(sessionId: string, hint: string) {
  try {
    const key = `pinloom:input:${sessionId}`;
    const existing = sessionStorage.getItem(key) ?? '';
    sessionStorage.setItem(key, existing ? `${hint}${existing}` : hint);
  } catch {
    // sessionStorage unavailable — the bot still opens, just without the seed.
  }
}

export function BotLauncher() {
  const navigate = useNavigate();
  const features = useFeatures();
  const [busy, setBusy] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the skill scope popover on outside click / Escape.
  useEffect(() => {
    if (!skillOpen) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSkillOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSkillOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [skillOpen]);

  async function openSchedule() {
    if (busy) return;
    setBusy(true);
    try {
      const session = await api.openBot('schedule');
      navigate(`/s/${session.id}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('failed to open schedule bot', err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSkill() {
    const next = !skillOpen;
    setSkillOpen(next);
    if (next && projects === null) {
      try {
        setProjects(await api.listProjects());
      } catch {
        setProjects([]);
      }
    }
  }

  async function openSkill(projectName: string | null) {
    if (busy) return;
    setBusy(true);
    setSkillOpen(false);
    try {
      const session = await api.openBot('skill');
      const hint = projectName
        ? `I want to create a skill for the project '${projectName}'. Turn the following into a skill:\n`
        : 'I want to create a global skill. Turn the following into a skill:\n';
      seedDraft(session.id, hint);
      navigate(`/s/${session.id}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('failed to open skill bot', err);
    } finally {
      setBusy(false);
    }
  }

  const btnClass =
    'inline-flex items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50';

  return (
    <>
      {features.scheduleBot && (
      <Tooltip label="Schedule bot">
        <button
          type="button"
          onClick={() => void openSchedule()}
          disabled={busy}
          aria-label="Schedule bot"
          className={btnClass}
        >
          <CalendarClock size={16} />
        </button>
      </Tooltip>
      )}

      {features.skillBot && (
      <div ref={wrapRef} className="relative">
        <Tooltip label="Skill bot">
          <button
            type="button"
            onClick={() => void toggleSkill()}
            disabled={busy}
            aria-label="Skill bot"
            className={btnClass}
          >
            <Wrench size={16} />
          </button>
        </Tooltip>
        {skillOpen && (
          <div className="absolute right-0 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg z-50">
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)]">
              Skill scope
            </div>
            <button
              type="button"
              onClick={() => void openSkill(null)}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-2)]"
            >
              Global (all projects)
            </button>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <div className="max-h-56 overflow-y-auto">
              {projects === null ? (
                <div className="px-2 py-1.5 text-xs text-[var(--color-ink-muted)]">
                  Loading…
                </div>
              ) : projects.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-[var(--color-ink-muted)]">
                  No projects
                </div>
              ) : (
                projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void openSkill(p.name)}
                    className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-2)]"
                    title={p.cwd}
                  >
                    {p.name}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      )}
    </>
  );
}
