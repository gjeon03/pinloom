// The four dockview panel components (chat / terminal / canvas / notepad).
// Params carry ONLY the target id — live data comes from DockContext so
// renames etc. propagate without re-creating panels. Content is gated on
// panel visibility (usePanelVisible) to preserve the pre-dock "only the
// foreground view is mounted" semantics per group.

import useSWR from 'swr';
import type { IDockviewPanelProps, IWatermarkPanelProps } from 'dockview-react';
import { api } from '../../api/client.js';
import { cacheKeys } from '../../api/cacheKeys.js';
import { ChatView } from '../ChatView.js';
import { AgentTerminal } from '../AgentTerminal.js';
import { TerminalSidePanel } from '../TerminalSidePanel.js';
import { ProjectNotepadView } from '../ProjectNotepadView.js';
import { TeamCanvasPage } from '../../pages/TeamCanvasPage.js';
import { useDock, usePanelVisible } from './DockContext.js';

export interface SessionPanelParams {
  kind: 'session';
  sessionId: string;
}
export interface CanvasPanelParams {
  kind: 'canvas';
  teamId: string;
}
export interface NotepadPanelParams {
  kind: 'notepad';
  notepadId: string;
}
export type DockPanelParams =
  | SessionPanelParams
  | CanvasPanelParams
  | NotepadPanelParams;

// Renders while a panel's target row hasn't arrived (or was deleted
// out-of-band — reconcileLayout closes such panels right after).
function MissingTarget({ label }: { label: string }) {
  return (
    <div className="p-6 text-sm text-[var(--color-ink-muted)]">{label}</div>
  );
}

export function ChatPanel(props: IDockviewPanelProps) {
  const { sessionId } = props.params as SessionPanelParams;
  const ctx = useDock();
  const visible = usePanelVisible(props.api);
  const session = ctx.sessionsById.get(sessionId);
  if (!visible) return null;
  if (!session) return <MissingTarget label="Session not found." />;
  return (
    // Force a fresh component instance per session so per-session local
    // state (textarea draft, queue, wikiSyncing flag, etc.) doesn't leak
    // across renders — same contract as the pre-dock keyed mount.
    <ChatView
      key={session.id}
      session={session}
      onPinChange={ctx.onPinChange}
      onSessionUpdate={ctx.onSessionUpdate}
    />
  );
}

export function TerminalPanel(props: IDockviewPanelProps) {
  const { sessionId } = props.params as SessionPanelParams;
  const ctx = useDock();
  const visible = usePanelVisible(props.api);
  const session = ctx.sessionsById.get(sessionId);
  // Per-panel pins fetch: with splits, two visible terminal sessions each
  // need their own pin list — a single focused-session pins store can't
  // serve both. SWR dedupes + caches across tab switches; onPinChange
  // mutates the same key (see ProjectPage.handlePinsChange).
  const { data: pinsData } = useSWR(
    visible && session ? cacheKeys.sessionPins(sessionId) : null,
    () => api.listPins(sessionId),
  );
  if (!visible) return null;
  if (!session) return <MissingTarget label="Session not found." />;
  return (
    <div className="flex h-full w-full min-h-0">
      <div className="min-w-0 flex-1">
        <AgentTerminal
          key={session.id}
          sessionId={session.id}
          onCleanExit={() => ctx.closeTerminalSession(session.id)}
        />
      </div>
      <TerminalSidePanel
        key={`panel-${session.id}`}
        sessionId={session.id}
        pins={pinsData ?? []}
        onPinChange={ctx.onPinChange}
        projectName={ctx.projectName}
        projectCwd={ctx.projectCwd}
        onHandoff={ctx.onHandoff}
        onSendPin={(pin) => ctx.onSendPin(session.id, pin)}
      />
    </div>
  );
}

export function CanvasPanel(props: IDockviewPanelProps) {
  const { teamId } = props.params as CanvasPanelParams;
  const visible = usePanelVisible(props.api);
  if (!visible) return null;
  // `key={teamId}` resets internal state on team switch so events from a
  // previous team don't bleed in; header suppressed because the tab strip
  // already shows which canvas this is.
  return <TeamCanvasPage key={teamId} teamId={teamId} showHeader={false} />;
}

export function NotepadPanel(props: IDockviewPanelProps) {
  const { notepadId } = props.params as NotepadPanelParams;
  const visible = usePanelVisible(props.api);
  if (!visible) return null;
  return <ProjectNotepadView key={notepadId} notepadId={notepadId} />;
}

// Shown when a group (or the whole dock) has no panels — rare, since the
// page guarantees at least one session, but reachable mid-load.
export function DockWatermark(_props: IWatermarkPanelProps) {
  return (
    <div className="h-full flex items-center justify-center p-6 text-sm text-[var(--color-ink-muted)]">
      No tabs here. Click + in the tab bar to create one.
    </div>
  );
}
