// Team-role helpers shared by the dock tab strip and its menus. Extracted
// verbatim from the legacy SessionTabs.tsx so the dockview ProjectTab and the
// tab-actions menu render the same badges/labels the old strip did.

import type { Team } from '@pinloom/shared';
import { Crown } from 'lucide-react';
import { Tooltip } from '../Tooltip.js';

export type TeamRole =
  | { kind: 'orchestrator'; teamId: string; teamName: string }
  | {
      kind: 'worker';
      teamId: string;
      teamName: string;
      alias: string;
      instructions: string | null;
      tags: string[];
    };

// Splits a comma-separated tags input into a clean array. Trims, drops
// empties, dedupes — server-side validation still applies pattern rules
// (lowercase, alnum + - / _) so a bad token surfaces an error there.
export function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function buildTeamRoles(teams: Team[]): Map<string, TeamRole> {
  const map = new Map<string, TeamRole>();
  for (const team of teams) {
    map.set(team.orchestratorSessionId, {
      kind: 'orchestrator',
      teamId: team.id,
      teamName: team.name,
    });
    for (const m of team.members) {
      map.set(m.sessionId, {
        kind: 'worker',
        teamId: team.id,
        teamName: team.name,
        alias: m.alias,
        instructions: m.instructions,
        tags: m.tags,
      });
    }
  }
  return map;
}

// Surfaces a session's role inside a team. Orchestrator gets a crown
// icon; workers get a "@alias" pill. The native title attribute carries
// the team name so the user can hover for full context without the
// badge eating tab width.
export function TeamRoleBadge({ role }: { role: TeamRole | null }) {
  if (!role) return null;
  if (role.kind === 'orchestrator') {
    return (
      <Tooltip label={`Orchestrator of team "${role.teamName}"`} side="top">
        <span className="inline-flex items-center text-[var(--color-accent)]">
          <Crown size={12} />
        </span>
      </Tooltip>
    );
  }
  // Compose tooltip from team name + tags + truncated instructions so
  // the user can scan a worker's role without opening its tab. Tooltip
  // renders as one line (whitespace-nowrap), so we use ' · ' as a soft
  // separator and truncate long instructions hard.
  const segments: string[] = [`@${role.alias} in team "${role.teamName}"`];
  if (role.tags.length > 0) {
    segments.push(role.tags.map((t) => `#${t}`).join(' '));
  }
  if (role.instructions) {
    const truncated =
      role.instructions.length > 120
        ? role.instructions.slice(0, 120) + '…'
        : role.instructions;
    segments.push(truncated.replace(/\s+/g, ' '));
  }
  return (
    <Tooltip label={segments.join(' · ')} side="top">
      <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-[1px] text-[10px] font-mono text-[var(--color-ink-muted)] whitespace-nowrap">
        @{role.alias}
      </span>
    </Tooltip>
  );
}
