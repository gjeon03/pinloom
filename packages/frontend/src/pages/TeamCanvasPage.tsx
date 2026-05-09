// Descriptive team-dispatch canvas — renders the team's orchestrator
// and workers as nodes, with edge color/animation driven entirely by
// each worker's running/queued state. The canvas does NOT author the
// graph; it observes what the orchestrator does at runtime.
//
// Data flow:
//   1. On mount, fetch team metadata + recent dispatch events (backfill)
//   2. Apply backfill BEFORE subscribing live so the latter naturally
//      wins on overlap. We additionally guard handleEvent with a per-
//      alias `at` timestamp so out-of-order events can't regress state.
//   3. Edge state derives from current worker_status only — no timer-
//      based fade, no stale-edge re-render churn.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Crown, ExternalLink } from 'lucide-react';
import type {
  Project,
  Session,
  Team,
  TeamDispatchEvent,
  WsEvent,
} from '@pinloom/shared';
import { api } from '../api/client.js';
import { AgentBadge } from '../components/AgentBadge.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface WorkerState {
  alias: string;
  sessionId: string;
  running: boolean;
  queued: number;
  /** Timestamp of the latest event we've applied for this alias.
   *  Older events (replayed backfill, out-of-order WS) are dropped. */
  lastEventAt: string;
}

interface CanvasNodeData extends Record<string, unknown> {
  kind: 'orchestrator' | 'worker';
  title: string;
  alias?: string;
  agent: 'claude' | 'codex' | null;
  projectName: string | null;
  sessionId: string;
  running?: boolean;
  queued?: number;
  edgeFresh?: boolean;
}

function statusColor(s: WorkerState): string {
  if (s.running) return '#facc15'; // yellow — actively working
  if (s.queued > 0) return '#60a5fa'; // blue — queued, will pick up
  return '#22c55e'; // green — idle
}

function statusLabel(s: WorkerState): string {
  if (s.running) return 'running';
  if (s.queued > 0) return `queued ${s.queued}`;
  return 'idle';
}

interface TeamCanvasPageProps {
  /** Optional override — when this page is rendered inline (e.g. as a
   *  tab inside ProjectPage), the parent passes the team id directly
   *  rather than relying on the route. The route variant fills this
   *  via useParams. */
  teamId?: string;
  /** Whether to render the page header (back link + team name + count).
   *  Inline mounts hide it because the SessionTabs strip already
   *  identifies the active canvas. Defaults to true. */
  showHeader?: boolean;
}

export function TeamCanvasPage({
  teamId: teamIdProp,
  showHeader = true,
}: TeamCanvasPageProps = {}) {
  const params = useParams<{ teamId: string }>();
  const teamId = teamIdProp ?? params.teamId;
  const [team, setTeam] = useState<Team | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [workersByAlias, setWorkersByAlias] = useState<
    Record<string, WorkerState>
  >({});

  const handleEvent = useCallback((event: TeamDispatchEvent) => {
    setWorkersByAlias((prev) => {
      const existing = prev[event.alias];
      // Drop stale events: backfill replay racing the live stream OR
      // out-of-order WS deliveries can't regress fresh state.
      if (existing && existing.lastEventAt > event.at) return prev;
      // dispatch_send carries no status — it's a "we just sent" pulse
      // we don't render directly. The follow-up worker_status from the
      // runner is what flips the node visual. Skip to avoid clobbering.
      if (event.type === 'dispatch_send') {
        if (!existing) {
          return {
            ...prev,
            [event.alias]: {
              alias: event.alias,
              sessionId: event.sessionId,
              running: false,
              queued: 0,
              lastEventAt: event.at,
            },
          };
        }
        return { ...prev, [event.alias]: { ...existing, lastEventAt: event.at } };
      }
      return {
        ...prev,
        [event.alias]: {
          alias: event.alias,
          sessionId: event.sessionId,
          running: event.running,
          queued: event.queued,
          lastEventAt: event.at,
        },
      };
    });
  }, []);

  const onWsMessage = useCallback(
    (msg: WsEvent) => {
      if (msg.type === 'team_dispatch_event') {
        handleEvent(msg.event);
      }
    },
    [handleEvent],
  );

  // Don't subscribe until backfill has been applied — that way live
  // events trump replayed backfill via the timestamp guard, and the
  // initial render has the historical state hydrated.
  const [loaded, setLoaded] = useState(false);
  useWebSocket(teamId && loaded ? `team:${teamId}` : null, onWsMessage);

  // Initial load: team meta + sessions + projects + event backfill.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    async function load() {
      try {
        const [t, s, p, events] = await Promise.all([
          api.getTeam(teamId!),
          api.listAllSessions(),
          api.listProjects(),
          api.listTeamDispatchEvents(teamId!),
        ]);
        if (cancelled) return;
        setTeam(t);
        setSessions(s);
        setProjects(p);
        // Replay backfill chronologically (sort defensively; the server
        // returns push-order, but interleaved emit paths can land in
        // not-quite-causal order — `at` is the canonical key).
        const sorted = [...events].sort((a, b) =>
          a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
        );
        for (const event of sorted) handleEvent(event);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // handleEvent is stable (empty deps useCallback); intentionally omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  function describe(sessionId: string): {
    title: string;
    agent: 'claude' | 'codex' | null;
    projectName: string | null;
  } {
    const session = sessionsById.get(sessionId);
    if (!session) {
      return {
        title: '(deleted session)',
        agent: null,
        projectName: null,
      };
    }
    const project = projectsById.get(session.projectId);
    return {
      title: session.title ?? `Chat ${session.id.slice(0, 6)}`,
      agent: session.agent,
      projectName: project?.name ?? null,
    };
  }

  const { nodes, edges } = useMemo<{
    nodes: Node<CanvasNodeData>[];
    edges: Edge[];
  }>(() => {
    if (!team) return { nodes: [], edges: [] };
    const orchMeta = describe(team.orchestratorSessionId);
    const orchNode: Node<CanvasNodeData> = {
      id: `orch-${team.orchestratorSessionId}`,
      type: 'pinloomNode',
      position: { x: 0, y: 0 },
      data: {
        kind: 'orchestrator',
        title: orchMeta.title,
        agent: orchMeta.agent,
        projectName: orchMeta.projectName,
        sessionId: team.orchestratorSessionId,
      },
    };

    // Workers radiate horizontally. For larger teams we'd switch to a
    // proper layout engine, but for ≤10 workers this is readable.
    const workerNodes: Node<CanvasNodeData>[] = team.members.map((m, i) => {
      const meta = describe(m.sessionId);
      const state = workersByAlias[m.alias];
      return {
        id: `worker-${m.sessionId}`,
        type: 'pinloomNode',
        position: {
          x: 320,
          y: i * 120 - ((team.members.length - 1) * 120) / 2,
        },
        data: {
          kind: 'worker',
          title: meta.title,
          alias: m.alias,
          agent: meta.agent,
          projectName: meta.projectName,
          sessionId: m.sessionId,
          running: state?.running ?? false,
          queued: state?.queued ?? 0,
        },
      };
    });

    // Edge appearance derives entirely from current worker state — no
    // wall-clock decay, so the canvas only re-renders edges when the
    // worker actually transitions running/queued/idle.
    const edges: Edge[] = team.members.map((m) => {
      const state = workersByAlias[m.alias];
      const running = state?.running ?? false;
      const queued = (state?.queued ?? 0) > 0;
      return {
        id: `e-${m.sessionId}`,
        source: orchNode.id,
        target: `worker-${m.sessionId}`,
        animated: running,
        style: {
          stroke: running ? '#facc15' : queued ? '#60a5fa' : '#374151',
          strokeWidth: running ? 2 : 1,
        },
      };
    });

    return { nodes: [orchNode, ...workerNodes], edges };
  }, [team, workersByAlias, sessionsById, projectsById]);

  if (!teamId) {
    return (
      <div className="p-8 text-sm text-[var(--color-ink-muted)]">
        Team id missing.
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-sm text-red-400">
        {error}
        <div className="mt-2">
          <Link to="/teams" className="text-[var(--color-accent)]">
            ← Back to Teams
          </Link>
        </div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="p-8 text-sm text-[var(--color-ink-muted)]">Loading…</div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {showHeader && (
        <div className="flex items-center gap-3 pl-6 pr-16 py-4 border-b border-[var(--color-border)]">
          <Link
            to="/teams"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
            aria-label="Back to Teams"
          >
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-sm font-semibold">{team.name}</h1>
          <span className="text-[11px] text-[var(--color-ink-muted)]">
            {team.members.length} worker{team.members.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={{ pinloomNode: CanvasNode }}
          fitView
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

interface CanvasNodeProps {
  data: CanvasNodeData;
}

function CanvasNode({ data }: CanvasNodeProps) {
  const isOrch = data.kind === 'orchestrator';
  const state: WorkerState = {
    alias: data.alias ?? '',
    sessionId: data.sessionId,
    running: data.running ?? false,
    queued: data.queued ?? 0,
    lastEventAt: '',
  };
  return (
    <div
      className={`rounded border bg-[var(--color-surface-2)] px-3 py-2 text-xs shadow-md ${
        isOrch
          ? 'border-[var(--color-accent)]'
          : 'border-[var(--color-border)]'
      }`}
      style={{ minWidth: 160 }}
    >
      {/* Source handle on the right of orchestrator; target on the left
          of workers. The opposite-side handles are also rendered (hidden)
          so React Flow's bidi rendering works without complaining. */}
      {isOrch ? (
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: 'var(--color-accent)' }}
        />
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: 'var(--color-accent)' }}
        />
      )}
      <div className="flex items-center gap-1.5 mb-1">
        {isOrch ? (
          <Crown size={12} className="text-[var(--color-accent)]" />
        ) : (
          <span
            className="font-mono text-[var(--color-accent)]"
            style={{ fontSize: 10 }}
          >
            @{data.alias}
          </span>
        )}
        {data.agent && <AgentBadge agent={data.agent} size="xs" />}
      </div>
      <div className="font-medium truncate" title={data.title}>
        {data.title}
      </div>
      {data.projectName && (
        <div className="text-[10px] text-[var(--color-ink-muted)] truncate">
          {data.projectName}
        </div>
      )}
      {!isOrch && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: statusColor(state) }}
          />
          <span className="text-[var(--color-ink-muted)]">
            {statusLabel(state)}
          </span>
          <Link
            to={`/s/${data.sessionId}`}
            className="ml-auto text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
            aria-label="Open session"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={10} />
          </Link>
        </div>
      )}
      {isOrch && (
        <div className="mt-1.5 text-right">
          <Link
            to={`/s/${data.sessionId}`}
            className="text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] inline-flex items-center gap-1"
            target="_blank"
            rel="noopener noreferrer"
          >
            open <ExternalLink size={10} />
          </Link>
        </div>
      )}
    </div>
  );
}
