import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Pin } from 'lucide-react';
import type { Message, WsEvent } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { PinToggleButton } from './MessageActions.js';

// Side panel for terminal-mode sessions: the live claude TUI is the main view,
// but the conversation is captured to the DB, so this lists the captured turns
// and lets the human pin assistant/user messages — the pin UI that ChatView
// provides for structured sessions. Pins are injected into the session's system
// prompt on its NEXT launch (the running TUI keeps its launch-time prompt), so a
// freshly-pinned note reaches claude after the session is reopened/resumed.

const collapsedKey = (sid: string) => `pinloom:termpanel:collapsed:${sid}`;

// How many rows to render initially / per "load older" step. Most opens want the
// latest turns (mirrors the terminal scrollback + ChatView), so we render the
// newest WINDOW and let the user scroll up to page in older history — keeps a
// long session's panel cheap without reversing the natural chat order.
const WINDOW = 60;

function preview(content: string, max = 600): string {
  const t = content.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function TerminalSidePanel({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinsOnly, setPinsOnly] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(collapsedKey(sessionId)) === '1',
  );
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(WINDOW);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-bottom: true while the user is parked at the latest turn. Opening the
  // panel and new live turns scroll to the bottom; once the user scrolls up to
  // read history we stop yanking them back down.
  const stick = useRef(true);
  // When we page in older rows (limit↑), the content above the viewport grows —
  // record the pre-grow scrollHeight so a layout effect can re-anchor and keep
  // the rows the user is looking at from jumping.
  const prependAnchor = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listMessages(sessionId)
      .then((m) => {
        if (!cancelled) setMessages(m);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const onWsEvent = useCallback(
    (ev: WsEvent) => {
      if (ev.type === 'message' && ev.sessionId === sessionId) {
        setMessages((prev) =>
          prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
        );
      } else if (ev.type === 'message_updated' && ev.sessionId === sessionId) {
        setMessages((prev) => prev.map((m) => (m.id === ev.message.id ? ev.message : m)));
      }
    },
    [sessionId],
  );
  useWebSocket(`session:${sessionId}`, onWsEvent);

  const togglePin = useCallback(async (m: Message) => {
    try {
      const updated = await api.updateMessage(m.id, { pinned: !m.pinned });
      setMessages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  function persistCollapsed(next: boolean) {
    setCollapsed(next);
    localStorage.setItem(collapsedKey(sessionId), next ? '1' : '0');
  }

  const rows = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && (!pinsOnly || m.pinned),
  );
  const pinCount = messages.filter((m) => m.pinned).length;
  // Render only the newest `limit` rows; older history pages in on scroll-up.
  const hasOlder = rows.length > limit;
  const windowed = hasOlder ? rows.slice(rows.length - limit) : rows;

  // Stick to the bottom on open and on new live turns — unless the user has
  // scrolled up to read history. Runs after the windowed list paints.
  useLayoutEffect(() => {
    if (prependAnchor.current !== null) return; // a load-older paint owns this frame
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [windowed.length, collapsed]);

  // Re-anchor after paging in older rows so the viewport doesn't jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prependAnchor.current !== null) {
      el.scrollTop += el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    }
  }, [limit]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    // Near the top with more history available → page in the next older chunk.
    // Skip if a prior page-in is still settling (prependAnchor not yet consumed)
    // so one scroll gesture doesn't stack several limit bumps.
    if (el.scrollTop < 80 && hasOlder && prependAnchor.current === null) {
      prependAnchor.current = el.scrollHeight;
      setLimit((n) => n + WINDOW);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => persistCollapsed(false)}
        title="Show history & pins"
        className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface-2)] py-2 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <ChevronRight className="h-4 w-4 rotate-180" />
        <Pin className="h-3.5 w-3.5" />
        {pinCount > 0 && <span className="text-[10px]">{pinCount}</span>}
      </button>
    );
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
          History & Pins
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPinsOnly((v) => !v)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              pinsOnly
                ? 'bg-[var(--color-accent)] text-black'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
            }`}
            title="Show pinned only"
          >
            Pinned{pinCount > 0 ? ` ${pinCount}` : ''}
          </button>
          <button
            type="button"
            onClick={() => persistCollapsed(true)}
            title="Collapse"
            className="px-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-ink-muted)]">
            {pinsOnly ? 'No pinned messages yet.' : 'Captured turns appear here as you chat.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {hasOlder && (
              <li className="py-1 text-center">
                <button
                  type="button"
                  onClick={() => {
                    const el = scrollRef.current;
                    if (el) prependAnchor.current = el.scrollHeight;
                    setLimit((n) => n + WINDOW);
                  }}
                  className="text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                >
                  Show older ({rows.length - limit})
                </button>
              </li>
            )}
            {windowed.map((m) => {
              if (m.role === 'tool') {
                return (
                  <li
                    key={m.id}
                    className="truncate px-2 text-[10px] text-[var(--color-ink-muted)]"
                    title={m.content}
                  >
                    $ {m.content}
                  </li>
                );
              }
              const isAssistant = m.role === 'assistant';
              return (
                <li
                  key={m.id}
                  className={`group relative rounded border px-2 py-1.5 text-xs ${
                    m.pinned
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                      : 'border-[var(--color-border)]/50'
                  }`}
                >
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
                      {isAssistant ? 'Assistant' : 'You'}
                    </span>
                    <PinToggleButton
                      pinned={m.pinned}
                      onClick={() => togglePin(m)}
                      size="sm"
                      hoverOnly={!m.pinned}
                    />
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[var(--color-ink)]">
                    {preview(m.content)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="border-t border-[var(--color-border)]/50 px-3 py-1.5 text-[9px] text-[var(--color-ink-muted)]">
        Pins apply on the session's next launch (the live TUI keeps its launch-time prompt).
      </footer>
    </aside>
  );
}
