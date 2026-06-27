import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { api } from '../api/client.js';

// Wiki similarity graph — a "related notes" map. Nodes = pages, edges = nearest
// neighbours by embedding (computed server-side). A one-shot d3-force run seeds
// the layout; from there it's an interactive SVG: hover a node to spotlight its
// neighbourhood, nodes are coloured by project, and the view pans/zooms/drags.
interface GNode extends SimulationNodeDatum {
  id: string;
  title: string;
  group: string;
}
type GLink = SimulationLinkDatum<GNode> & { weight: number };

const W = 1000;
const H = 700;
const PAD = 48;
const PALETTE = [
  '#2dd4bf', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa',
  '#34d399', '#fb7185', '#38bdf8', '#f59e0b', '#c084fc', '#4ade80', '#e879f9',
];

const labelWidth = (n: { title: string }) => 12 + Math.min(n.title.length, 28) * 5.6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface VBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function WikiGraphModal({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useSWR('wiki:graph', () => api.getWikiGraph());
  // Group-scope filter (Work / Personal / …). '' = all. Dims (not hides) nodes
  // outside the group so the force layout stays put and context is preserved.
  const { data: projectGroups = [] } = useSWR('project-groups', () => api.listProjectGroups());
  const [filterGroupId, setFilterGroupId] = useState('');
  const groupSet = useMemo(() => {
    if (!filterGroupId || !data) return null;
    const ids = new Set<string>();
    for (const n of data.nodes) {
      const match =
        filterGroupId === '__ungrouped__' ? n.groupId === null : n.groupId === filterGroupId;
      if (match) ids.add(n.id);
    }
    return ids;
  }, [filterGroupId, data]);
  const navigate = useNavigate();
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Per-group colour (distinct projects → palette, stable order).
  const groupColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of data?.nodes ?? []) {
      if (!m.has(n.group)) m.set(n.group, PALETTE[m.size % PALETTE.length]);
    }
    return m;
  }, [data]);

  // Adjacency for hover spotlight.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of data?.edges ?? []) {
      (m.get(e.source) ?? m.set(e.source, new Set()).get(e.source)!).add(e.target);
      (m.get(e.target) ?? m.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return m;
  }, [data]);

  // One-shot force layout → initial positions + a fitted viewBox (the viewBox
  // bounds include label widths so right-edge labels aren't clipped).
  const initial = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const nodes: GNode[] = data.nodes.map((n) => ({ ...n }));
    const links: GLink[] = data.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
    forceSimulation(nodes)
      .force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance((l) => 70 + (1 - l.weight) * 180).strength(0.5))
      .force('charge', forceManyBody().strength(-380))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(40))
      .stop()
      .tick(320);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) pos[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs) - PAD;
    const minY = Math.min(...ys) - PAD;
    const maxX = Math.max(...nodes.map((n) => (n.x ?? 0) + labelWidth(n))) + PAD;
    const maxY = Math.max(...ys) + PAD;
    return { pos, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } as VBox };
  }, [data]);

  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [vb, setVb] = useState<VBox | null>(null);
  const vbRef = useRef<VBox | null>(null);
  vbRef.current = vb;
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Active drag (a ref so per-pixel moves don't thrash React state setters).
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; cx: number; cy: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (initial) {
      setPos(initial.pos);
      setVb(initial.box);
    }
  }, [initial]);

  // Screen → world, accounting for the meet-letterboxing of preserveAspectRatio.
  function toWorld(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg || !vb) return { x: 0, y: 0, scale: 1 };
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / vb.w, r.height / vb.h); // "meet"
    const offX = (r.width - vb.w * scale) / 2;
    const offY = (r.height - vb.h * scale) / 2;
    return { x: vb.x + (clientX - r.left - offX) / scale, y: vb.y + (clientY - r.top - offY) / scale, scale };
  }

  // Zoom by `factor` (<1 = in) about a world anchor, kept fixed on screen.
  // Shared by the wheel + the +/−/fit buttons.
  function zoomTo(factor: number, wx: number, wy: number) {
    const cur = vbRef.current;
    if (!cur) return;
    const w = clamp(cur.w * factor, (initial?.box.w ?? W) / 6, (initial?.box.w ?? W) * 3);
    const h = cur.h * (w / cur.w);
    const fx = (wx - cur.x) / cur.w;
    const fy = (wy - cur.y) / cur.h;
    setVb({ x: wx - fx * w, y: wy - fy * h, w, h });
  }
  function zoomCenter(factor: number) {
    const cur = vbRef.current;
    if (cur) zoomTo(factor, cur.x + cur.w / 2, cur.y + cur.h / 2);
  }

  // Wheel zoom must use a NON-passive native listener — React's synthetic onWheel
  // is passive, so preventDefault() there throws and the page scrolls instead.
  // Gentle: zoom is proportional to scroll delta and capped at ±8% per event, so
  // a fast trackpad flick doesn't slam between min/max.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      if (!vbRef.current) return;
      e.preventDefault();
      const factor = clamp(Math.exp(e.deltaY * 0.0012), 0.92, 1.08);
      const p = toWorld(e.clientX, e.clientY);
      zoomTo(factor, p.x, p.y);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
    // Re-attach once the svg first mounts (vb flips null → set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vb !== null]);

  function onMouseDownBg(e: React.MouseEvent) {
    drag.current = { kind: 'pan', cx: e.clientX, cy: e.clientY, moved: false };
  }
  function onMouseDownNode(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    drag.current = { kind: 'node', id, cx: e.clientX, cy: e.clientY, moved: false };
  }
  function onMouseMove(e: React.MouseEvent) {
    const d = drag.current;
    if (!d || !vb) return;
    if (Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) > 3) d.moved = true;
    if (d.kind === 'pan') {
      const r = svgRef.current!.getBoundingClientRect();
      const scale = Math.min(r.width / vb.w, r.height / vb.h);
      setVb({ ...vb, x: vb.x - (e.clientX - d.cx) / scale, y: vb.y - (e.clientY - d.cy) / scale });
      d.cx = e.clientX;
      d.cy = e.clientY;
    } else if (d.kind === 'node' && d.id) {
      const p = toWorld(e.clientX, e.clientY);
      setPos((prev) => ({ ...prev, [d.id!]: { x: p.x, y: p.y } }));
    }
  }
  function endDrag() {
    drag.current = null;
  }
  function onNodeClick(id: string) {
    if (drag.current?.moved) return; // a drag, not a click
    navigate(`/wiki/${encodeURIComponent(`${id}.md`)}`);
    onClose();
  }

  const active = hoverId ? new Set<string>([hoverId, ...(adj.get(hoverId) ?? [])]) : null;
  const groups = [...groupColor.entries()];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Wiki graph"
        className="relative flex w-full max-w-5xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] cursor-default"
        style={{ height: 'min(84vh, 760px)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="text-sm font-semibold">
            Wiki graph
            <span className="ml-2 text-xs font-normal text-[var(--color-ink-muted)]">
              related notes by meaning · hover to spotlight · scroll to zoom · drag to pan
              {data?.truncated ? ' · showing first 400' : ''}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden">
          {vb && projectGroups.length > 0 && (
            <select
              value={filterGroupId}
              onChange={(e) => setFilterGroupId(e.target.value)}
              title="Highlight a project group"
              className="absolute left-3 top-3 z-10 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink-muted)] shadow"
            >
              <option value="">All groups</option>
              {projectGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="__ungrouped__">Ungrouped</option>
            </select>
          )}
          {vb && (
            <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow">
              <button
                onClick={() => zoomCenter(1 / 1.4)}
                title="Zoom in"
                aria-label="Zoom in"
                className="flex h-7 w-7 items-center justify-center text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
              >
                <ZoomIn size={14} />
              </button>
              <button
                onClick={() => zoomCenter(1.4)}
                title="Zoom out"
                aria-label="Zoom out"
                className="flex h-7 w-7 items-center justify-center border-t border-[var(--color-border)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
              >
                <ZoomOut size={14} />
              </button>
              <button
                onClick={() => initial && setVb(initial.box)}
                title="Fit to view"
                aria-label="Fit to view"
                className="flex h-7 w-7 items-center justify-center border-t border-[var(--color-border)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
              >
                <Maximize size={13} />
              </button>
            </div>
          )}
          {isLoading && !vb ? (
            <div className="p-6 text-sm text-[var(--color-ink-muted)]">Building graph…</div>
          ) : !data || data.nodes.length === 0 || !vb ? (
            <div className="p-6 text-sm text-[var(--color-ink-muted)]">
              No graph yet — the wiki isn’t semantically indexed (embeddings off or still
              warming). Once it indexes, related pages connect here.
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              preserveAspectRatio="xMidYMid meet"
              className="h-full w-full select-none"
              style={{ cursor: drag.current?.kind === 'pan' ? 'grabbing' : 'grab' }}
              onMouseDown={onMouseDownBg}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              {data.edges.map((l, i) => {
                const s = pos[l.source];
                const t = pos[l.target];
                if (!s || !t) return null;
                const touch = hoverId && (l.source === hoverId || l.target === hoverId);
                const dim = active && !touch;
                // Edge belongs to the filtered group only if BOTH endpoints do.
                const outGroup = groupSet && !(groupSet.has(l.source) && groupSet.has(l.target));
                return (
                  <line
                    key={i}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={touch ? 'var(--color-accent)' : 'var(--color-border)'}
                    strokeWidth={(touch ? 1.2 : 0.5) + l.weight}
                    strokeOpacity={
                      outGroup ? 0.03 : dim ? 0.05 : touch ? 0.8 : 0.28 + (l.weight - 0.6) * 1.0
                    }
                  />
                );
              })}
              {data.nodes.map((n) => {
                const p = pos[n.id];
                if (!p) return null;
                const on = !active || active.has(n.id);
                const inGroup = !groupSet || groupSet.has(n.id);
                const color = groupColor.get(n.group) ?? '#888';
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    style={{ cursor: 'pointer', opacity: inGroup ? (on ? 1 : 0.12) : 0.05 }}
                    onMouseEnter={() => !drag.current && setHoverId(n.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onMouseDown={(e) => onMouseDownNode(e, n.id)}
                    onClick={() => onNodeClick(n.id)}
                  >
                    <circle
                      r={n.id === hoverId ? 8 : 6}
                      fill={color}
                      stroke="var(--color-surface)"
                      strokeWidth={1.5}
                    />
                    <text x={9} y={3.5} fontSize={9} className="fill-[var(--color-ink)]" style={{ pointerEvents: 'none' }}>
                      {n.title.length > 28 ? `${n.title.slice(0, 28)}…` : n.title}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Project legend */}
        {vb && groups.length > 0 && (
          <div className="absolute bottom-2 left-2 flex max-w-[70%] flex-wrap gap-x-3 gap-y-1 rounded bg-[var(--color-surface)]/80 px-2 py-1 text-[10px] text-[var(--color-ink-muted)] backdrop-blur">
            {groups.map(([g, c]) => (
              <span key={g} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
