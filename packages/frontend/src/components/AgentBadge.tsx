import type { AgentKind } from '@pinloom/shared';

interface Props {
  agent: AgentKind;
  /** Compact (xs, ~14px) for inline-after-text; default (sm, ~16px) for tabs. */
  size?: 'xs' | 'sm';
}

export function AgentBadge({ agent, size = 'sm' }: Props) {
  const isCodex = agent === 'codex';
  // Lean palette: subtle tinted border + soft fill + saturated foreground.
  // We avoid bright fills so the badge doesn't fight the existing tab/chat
  // chrome — the goal is "glanceable", not loud.
  const palette = isCodex
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
    : 'border-orange-500/40 bg-orange-500/10 text-orange-400';
  const sizing =
    size === 'xs'
      ? 'h-3.5 min-w-[14px] text-[8px]'
      : 'h-4 min-w-[16px] text-[9px]';
  const letter = isCodex ? 'X' : 'C';
  const label = isCodex ? 'Codex' : 'Claude';
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded border px-1 font-bold tracking-wide leading-none ${palette} ${sizing}`}
    >
      {letter}
    </span>
  );
}
