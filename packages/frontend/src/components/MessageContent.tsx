import type { PlanItem } from '@planloom/shared';

const MENTION_RE = /@([A-Za-z0-9_-]{10,})/g;

export function MessageContent({
  content,
  items,
}: {
  content: string;
  items: PlanItem[];
}) {
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'mention'; item: PlanItem; raw: string }> = [];

  let lastIndex = 0;
  for (const match of content.matchAll(MENTION_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ kind: 'text', value: content.slice(lastIndex, start) });
    }
    const id = match[1];
    const item = itemById.get(id);
    if (item) {
      parts.push({ kind: 'mention', item, raw: match[0] });
    } else {
      parts.push({ kind: 'text', value: match[0] });
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ kind: 'text', value: content.slice(lastIndex) });
  }

  return (
    <span className="whitespace-pre-wrap text-sm">
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.value}</span>
        ) : (
          <span
            key={i}
            title={part.item.id}
            className="mx-0.5 inline-flex items-center rounded bg-[var(--color-accent)]/20 px-1.5 py-0.5 text-xs text-[var(--color-accent)] font-medium"
          >
            @ {part.item.title}
          </span>
        ),
      )}
    </span>
  );
}
