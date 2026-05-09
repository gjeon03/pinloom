// Descriptive team-dispatch canvas — renders the team's orchestrator
// and workers as nodes, with edges showing recent dispatch_send events
// and node pulses driven by worker_status. The canvas does NOT author
// the graph; it observes what the orchestrator does at runtime.
//
// Data flow:
//   1. On mount, fetch team metadata + recent dispatch events (backfill)
//   2. Subscribe to `team:${teamId}` WS channel for live events
//   3. Reduce events into derived `nodeStates` (status per worker) and
//      `edgePulses` (timestamp of most recent dispatch per alias)
//   4. Stale edges fade after EDGE_FRESH_MS

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const EDGE_FRESH_MS = 30_000;

interface WorkerState {
  alias: string;
  sessionId: string;
  running: boolean;
  queued: number;
  /** ISO timestamp of the most recent dispatch_send to this worker. */
  lastDispatchAt: string | null;
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

export function TeamCanvasPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const [team, setTeam] = useState<Team | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [workersByAlias, setWorkersByAlias] = useState<
    Record<string, WorkerState>
  >({});
  // Tick state used so the edge-fresh decay refreshes the render even
  // when no new event has arrived. Bumped every 5s.
  const [, setNow] = useState(Date.now());

  const handleEvent = useCallback((event: TeamDispatchEvent) => {
    setWorkersByAlias((prev) => {
      const next = { ...prev };
      const existing = next[event.alias] ?? {
        alias: event.alias,
        sessionId: event.sessionId,
        running: false,
        queued: 0,
        lastDispatchAt: null,
      };
      if (event.type === 'dispatch_send') {
        next[event.alias] = { ...existing, lastDispatchAt: event.at };
      } else {
        next[event.alias] = {
          ...existing,
          running: event.running,
          queued: event.queued,
        };
      }
      return next;
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

  useWebSocket(teamId ? `team:${teamId}` : null, onWsMessage);

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
        // Replay backfill chronologically so the latest event wins per
        // alias. The setState reducer handles partial-update merging.
        for (const event of events) handleEvent(event);
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
  }, [teamId, handleEvent]);

  // Tick to fade edges after EDGE_FRESH_MS without a new event.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

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
      const state =
        workersByAlias[m.alias] ?? {
          alias: m.alias,
          sessionId: m.sessionId,
          running: false,
          queued: 0,
          lastDispatchAt: null,
        };
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
          running: state.running,
          queued: state.queued,
        },
      };
    });

    const now = Date.now();
    const edges: Edge[] = team.members.map((m) => {
      const state = workersByAlias[m.alias];
      const fresh =
        state?.lastDispatchAt &&
        now - new Date(state.lastDispatchAt).getTime() < EDGE_FRESH_MS;
      const running = state?.running ?? false;
      const queued = (state?.queued ?? 0) > 0;
      return {
        id: `e-${m.sessionId}`,
        source: orchNode.id,
        target: `worker-${m.sessionId}`,
        animated: fresh || running,
        style: {
          stroke: fresh
            ? '#facc15'
            : running
              ? '#facc15'
              : queued
                ? '#60a5fa'
                : '#374151',
          strokeWidth: fresh || running ? 2 : 1,
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
      <div className="flex items-center gap-3 px-6 py-3 border-b border-[var(--color-border)]">
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
    lastDispatchAt: null,
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
