import type { Message } from '@pinloom/shared';

function pinKey(m: Message): string {
  return m.pinnedAt ?? m.createdAt;
}

export function applyPinChange(prev: Message[], updated: Message): Message[] {
  const exists = prev.some((p) => p.id === updated.id);
  if (updated.pinned) {
    if (exists) {
      return prev.map((p) => (p.id === updated.id ? updated : p));
    }
    const next = [...prev, updated];
    next.sort((a, b) => pinKey(a).localeCompare(pinKey(b)));
    return next;
  }
  return prev.filter((p) => p.id !== updated.id);
}
