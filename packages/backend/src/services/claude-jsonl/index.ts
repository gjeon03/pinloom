// Claude Code transcript (JSONL) parsing + token accounting. Pure, I/O-free,
// reused by the PTY completion detector and the usage meter (issue #21).

export {
  parseJsonlLine,
  parseJsonlLines,
  collectUuids,
  selectTurnLines,
  summarizeToolCall,
  toNormalizedEvents,
} from './parse.js';
export { aggregateUsage } from './usage.js';
export type { TokenTotals, UsageBreakdown } from './usage.js';
export {
  NOISE_TYPES,
  SYNTHETIC_MODEL,
  type JsonlLine,
  type JsonlMessage,
  type JsonlContentBlock,
  type JsonlUsage,
  type JsonlTopLevelType,
} from './types.js';
