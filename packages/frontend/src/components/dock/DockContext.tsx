// Context bridging ProjectPage state/actions into dockview panel + tab
// components. Panels carry only ids in their (serialized) params; live data
// (session rows, team roles, canvas/notepad metadata) is looked up here so a
// rename re-renders tabs without re-creating panels.

import { createContext, useContext, useEffect, useState } from 'react';
import type {
  AgentKind,
  Message,
  ProjectNotepadSummary,
  Session,
  Team,
} from '@pinloom/shared';
import type { DockviewPanelApi } from 'dockview-react';
import type { TeamRole } from '../tabs/teamRoles.js';
import type { InlineCanvasTab } from './layout.js';

export interface TabMenuRequest {
  sessionId: string;
  top: number;
  left: number;
}

export interface DockContextValue {
  projectId: string;
  projectName: string;
  projectCwd: string;
  sessionsById: Map<string, Session>;
  canvasesById: Map<string, InlineCanvasTab>;
  notepadsById: Map<string, ProjectNotepadSummary>;
  rolesBySessionId: Map<string, TeamRole>;
  teams: Team[];
  sessionCount: number;
  codexAvailable: boolean | null;
  // tab actions
  openTabMenu: (req: TabMenuRequest) => void;
  renameSession: (sessionId: string, title: string | null) => Promise<void>;
  renameNotepad: (id: string, name: string) => void;
  closeCanvas: (teamId: string) => void;
  deleteNotepad: (id: string) => void;
  createSessionTab: (agent: AgentKind, groupId: string | null) => void;
  createNotepadTab: (groupId: string | null) => void;
  // panel content callbacks
  onSessionUpdate: (updated: Session) => void;
  onPinChange: (updated: Message) => void;
  onHandoff: (newSession: Session) => void;
  onSendPin: (sessionId: string, pin: Message) => void;
  closeTerminalSession: (sessionId: string) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

export function DockProvider({
  value,
  children,
}: {
  value: DockContextValue;
  children: React.ReactNode;
}) {
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error('useDock must be used inside DockProvider');
  return ctx;
}

// Tracks a dockview panel's visibility (its group's selected tab). Panel
// CONTENT mounts only while visible — this reproduces the pre-dock semantics
// where exactly the foreground view was mounted (xterm WS attach, ChatView
// subscriptions, canvas polling all tear down when the tab goes background),
// and sidesteps xterm-in-hidden-container rendering issues.
export function usePanelVisible(api: DockviewPanelApi): boolean {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  return visible;
}

// Tracks whether a panel is the active one inside its group (drives tab
// styling parity with the old strip's active-tab colors).
export function usePanelActive(api: DockviewPanelApi): boolean {
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    setActive(api.isActive);
    const d = api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  return active;
}
