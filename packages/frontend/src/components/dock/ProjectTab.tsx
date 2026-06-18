// Custom dockview tab — ports the legacy SessionTabs tab UI verbatim:
// sessions get AgentBadge + TeamRoleBadge + double-click rename + the 3-dot
// actions menu; canvases get the Network icon + close X; notepads get the
// NotepadText icon + double-click rename + delete X. dockview owns drag &
// click-to-activate; we only render the inner content.

import { useState } from 'react';
import { MoreVertical, Network, NotepadText, X } from 'lucide-react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { AgentBadge } from '../AgentBadge.js';
import { TeamRoleBadge } from '../tabs/teamRoles.js';
import { useDock, usePanelActive } from './DockContext.js';
import { useSessionRunning } from '../../stores/sessionRunning.js';
import type { DockPanelParams } from './panels.js';

// A small pulsing dot shown on a session tab while its agent is mid-turn, so a
// background run you've navigated away from is easy to spot and jump back to.
function RunningDot() {
  return (
    <span
      title="Agent is working…"
      className="relative flex h-2 w-2 shrink-0"
      aria-label="running"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
    </span>
  );
}

export function ProjectTab(props: IDockviewPanelHeaderProps) {
  const params = props.params as DockPanelParams;
  const ctx = useDock();
  const active = usePanelActive(props.api);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  // Hooks must run unconditionally; '' is never a running session id, so
  // non-session tabs just get `false`.
  const sessionRunning = useSessionRunning(
    params.kind === 'session' ? params.sessionId : '',
  );

  // While the rename input is up, swallow drag starts so selecting text
  // doesn't yank the whole tab into a dockview drag. The input is marked
  // draggable so IT becomes the dragstart origin (instead of the .dv-tab
  // ancestor), letting preventDefault cancel the drag outright.
  const dragCancelProps = editing
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};

  const baseClass = `flex h-full items-center gap-1 px-3 text-sm ${
    active
      ? 'text-[var(--color-ink)]'
      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
  }`;

  if (params.kind === 'session') {
    const s = ctx.sessionsById.get(params.sessionId);
    if (!s) return <div className={baseClass}>…</div>;
    const label = s.title ?? `Chat ${s.id.slice(0, 6)}`;
    const save = () => {
      const next = editValue.trim() || null;
      setEditing(false);
      void ctx.renameSession(s.id, next);
    };
    return (
      <div
        className={`group ${baseClass}`}
        onDoubleClick={() => {
          setEditValue(s.title ?? '');
          setEditing(true);
        }}
        {...dragCancelProps}
      >
        <AgentBadge agent={s.agent} size="xs" />
        <TeamRoleBadge role={ctx.rolesBySessionId.get(s.id) ?? null} />
        {sessionRunning && <RunningDot />}
        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1 text-sm w-32"
          />
        ) : (
          <span className="truncate max-w-[180px]">{label}</span>
        )}
        <button
          type="button"
          data-tab-menu-trigger
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            ctx.openTabMenu({
              sessionId: s.id,
              top: r.bottom + 4,
              left: r.left,
            });
          }}
          title="Tab actions"
          className={`p-0.5 rounded transition-opacity ${
            active
              ? 'text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
              : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
          }`}
        >
          <MoreVertical size={12} />
        </button>
      </div>
    );
  }

  if (params.kind === 'canvas') {
    const c = ctx.canvasesById.get(params.teamId);
    if (!c) return <div className={baseClass}>…</div>;
    return (
      <div className={`group ${baseClass}`} title={`Canvas — ${c.teamName}`}>
        <Network size={12} className="text-[var(--color-accent)] shrink-0" />
        <span className="truncate max-w-[160px]">{c.teamName}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ctx.closeCanvas(c.teamId);
          }}
          className={`p-0.5 rounded transition-opacity ${
            active
              ? 'text-[var(--color-ink-muted)] hover:text-red-400'
              : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400'
          }`}
          title="Close canvas tab"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  // params.kind === 'notepad'
  const n = ctx.notepadsById.get(params.notepadId);
  if (!n) return <div className={baseClass}>…</div>;
  const saveNotepad = () => {
    const v = editValue.trim();
    setEditing(false);
    if (v) ctx.renameNotepad(n.id, v);
  };
  return (
    <div
      className={`group ${baseClass}`}
      onDoubleClick={() => {
        setEditValue(n.name);
        setEditing(true);
      }}
      title={`Notepad — ${n.name}`}
      {...dragCancelProps}
    >
      <NotepadText size={12} className="shrink-0 text-[var(--color-accent)]" />
      {editing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={saveNotepad}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveNotepad();
            if (e.key === 'Escape') setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1 text-sm w-32"
        />
      ) : (
        <span className="truncate max-w-[160px]">{n.name}</span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${n.name}"? This cannot be undone.`)) {
            ctx.deleteNotepad(n.id);
          }
        }}
        title="Delete notepad"
        className={`p-0.5 rounded transition-opacity ${
          active
            ? 'text-[var(--color-ink-muted)] hover:text-red-400'
            : 'opacity-40 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-red-400'
        }`}
      >
        <X size={12} />
      </button>
    </div>
  );
}
