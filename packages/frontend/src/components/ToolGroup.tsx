import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { Message } from '@pinloom/shared';
import { ToolMessage } from './ToolMessage.js';

interface Props {
  messages: Message[];
}

interface ToolPayload {
  name?: string;
}

function parsePayload(raw: string | null): ToolPayload | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ToolPayload;
  } catch {
    return null;
  }
}

function summarizeNames(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const name = parsePayload(m.toolUse)?.name ?? 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name}·${count}` : name))
    .join(', ');
}

export function ToolGroup({ messages }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;

  // Single tool — render as a normal bubble (no group overhead).
  if (messages.length === 1) {
    return (
      <div className="rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-yellow-100 font-mono text-sm">
        <ToolMessage message={messages[0]} />
      </div>
    );
  }

  return (
    <div className="rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-100 font-mono text-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-yellow-500/15 text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="opacity-70 shrink-0" />
        ) : (
          <ChevronRight size={12} className="opacity-70 shrink-0" />
        )}
        <Wrench size={12} className="shrink-0 opacity-80" />
        <span className="font-semibold">Used {messages.length} tools</span>
        <span className="flex-1 truncate text-yellow-100/60 font-sans text-[11px]">
          {summarizeNames(messages)}
        </span>
      </button>
      {expanded && (
        <ul className="divide-y divide-yellow-500/20 border-t border-yellow-500/20">
          {messages.map((m) => (
            <li key={m.id} className="px-3 py-2">
              <ToolMessage message={m} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
