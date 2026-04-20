import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
        <div className="px-4 py-3 text-sm font-semibold tracking-wide">
          planloom
        </div>
        <nav className="flex flex-col gap-1 px-2 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `rounded px-2 py-1.5 ${
                isActive
                  ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
              }`
            }
          >
            Projects
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `rounded px-2 py-1.5 ${
                isActive
                  ? 'bg-[var(--color-surface-3)] text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)]'
              }`
            }
          >
            Settings
          </NavLink>
        </nav>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
