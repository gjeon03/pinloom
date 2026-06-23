import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { BotKind } from '@pinloom/shared';
import { api } from '../api/client.js';

interface BotEntry {
  kind: BotKind;
  icon: LucideIcon;
  label: string;
}

// Built-in bots, rendered as top-right launcher buttons. Each opens (or reuses)
// its singleton session and navigates to it. Add an entry here as new bots ship.
const BOTS: BotEntry[] = [
  { kind: 'schedule', icon: CalendarClock, label: '일정 봇' },
];

export function BotLauncher() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<BotKind | null>(null);

  async function open(kind: BotKind) {
    if (busy) return;
    setBusy(kind);
    try {
      const session = await api.openBot(kind);
      navigate(`/s/${session.id}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`failed to open ${kind} bot`, err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {BOTS.map(({ kind, icon: Icon, label }) => (
        <button
          key={kind}
          type="button"
          onClick={() => void open(kind)}
          disabled={busy !== null}
          title={label}
          aria-label={label}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          <Icon size={16} />
        </button>
      ))}
    </>
  );
}
