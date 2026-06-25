import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { X } from 'lucide-react';
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
// neighbours by embedding (computed server-side). Layout is a one-shot d3-force
// run (static, no animation — fine for the modest page count); click a node to
// open it. Empty state when the wiki isn't vector-indexed yet.
interface GNode extends SimulationNodeDatum {
  id: string;
  title: string;
}
type GLink = SimulationLinkDatum<GNode> & { weight: number };

const W = 900;
const H = 640;
const PAD = 40;

export function WikiGraphModal({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useSWR('wiki:graph', () => api.getWikiGraph());
  const navigate = useNavigate();

  const layout = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const nodes: GNode[] = data.nodes.map((n) => ({ ...n }));
    const links: GLink[] = data.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    }));
    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance((l) => 60 + (1 - l.weight) * 160)
          .strength(0.5),
      )
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(34))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    // Fit to viewBox.
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs) - PAD;
    const minY = Math.min(...ys) - PAD;
    const w = Math.max(...xs) - minX + PAD;
    const h = Math.max(...ys) - minY + PAD;
    return { nodes, links, viewBox: `${minX} ${minY} ${w} ${h}` };
  }, [data]);

  function open(slug: string) {
    navigate(`/wiki/${encodeURIComponent(`${slug}.md`)}`);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 cursor-pointer"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Wiki graph"
        className="flex w-full max-w-4xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] cursor-default"
        style={{ height: 'min(80vh, 720px)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="text-sm font-semibold">
            Wiki graph
            <span className="ml-2 text-xs font-normal text-[var(--color-ink-muted)]">
              related notes by meaning{data?.truncated ? ' · showing first 400' : ''}
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

        <div className="flex-1 min-h-0 overflow-hidden">
          {isLoading && !layout ? (
            <div className="p-6 text-sm text-[var(--color-ink-muted)]">Building graph…</div>
          ) : !layout ? (
            <div className="p-6 text-sm text-[var(--color-ink-muted)]">
              No graph yet — the wiki isn’t semantically indexed (embeddings off or still
              warming). Once it indexes, related pages connect here.
            </div>
          ) : (
            <svg viewBox={layout.viewBox} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
              {layout.links.map((l, i) => {
                const s = l.source as GNode;
                const t = l.target as GNode;
                return (
                  <line
                    key={i}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke="var(--color-border)"
                    strokeWidth={0.5 + l.weight}
                    strokeOpacity={0.25 + (l.weight - 0.6) * 1.2}
                  />
                );
              })}
              {layout.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  onClick={() => open(n.id)}
                >
                  <circle r={6} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={1.5} />
                  <text
                    x={9}
                    y={3.5}
                    fontSize={9}
                    className="fill-[var(--color-ink)]"
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.title.length > 28 ? `${n.title.slice(0, 28)}…` : n.title}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
