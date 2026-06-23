// Bot registry — maps a bot_kind to its persona (system prompt), session title,
// and working-directory resolver. The runner consults this when a session has a
// non-null bot_kind to swap in the bot's prompt + cwd; everything else (adapter,
// streaming, persistence, the pinloom MCP tools) is the normal session path.
//
// Only IMPLEMENTED kinds appear in DEFINITIONS. `BotKind` (shared) may list a
// kind before it ships here, so getBotDefinition returns null for not-yet-built
// bots and callers (the open route) reject them with a 400.

import type { BotKind } from '@pinloom/shared';
import { SCHEDULE_SYSTEM_PROMPT, resolveScheduleCwd } from './schedule.js';

export interface BotDefinition {
  kind: BotKind;
  /** Session title shown in the chat header / tab. */
  title: string;
  systemPrompt: string;
  /** Absolute cwd the agent runs in. `home` is injectable for tests. */
  resolveCwd(home?: string): string;
}

const DEFINITIONS: Partial<Record<BotKind, BotDefinition>> = {
  schedule: {
    kind: 'schedule',
    title: '일정 봇',
    systemPrompt: SCHEDULE_SYSTEM_PROMPT,
    resolveCwd: resolveScheduleCwd,
  },
};

export function isBotKind(value: unknown): value is BotKind {
  return value === 'schedule' || value === 'skill';
}

export function getBotDefinition(kind: string): BotDefinition | null {
  return (DEFINITIONS as Record<string, BotDefinition | undefined>)[kind] ?? null;
}
