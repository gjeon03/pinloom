import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Plan, PlanItem, Project, Session } from '@planloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { MentionPicker } from './MentionPicker.js';
import { MessageContent } from './MessageContent.js';

interface Props {
  project: Project;
  activePlan: Plan | null;
  items: PlanItem[];
}

export function ChatPanel({ project, activePlan, items }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setMessages([]);
    setError(null);

    api
      .listSessions(project.id)
      .then(async (list) => {
        if (cancelled) return;
        const matching = activePlan
          ? list.find((s) => s.planId === activePlan.id)
          : list[0];
        if (matching) {
          setSession(matching);
          const msgs = await api.listMessages(matching.id);
          if (!cancelled) setMessages(msgs);
        } else if (activePlan) {
          const created = await api.createSession(project.id, {
            planId: activePlan.id,
            title: activePlan.title,
          });
          if (!cancelled) {
            setSession(created);
            setMessages([]);
          }
        }
      })
      .catch((e) => !cancelled && setError(String(e)));

    return () => {
      cancelled = true;
    };
  }, [project.id, activePlan?.id]);

  const channel = useMemo(
    () => (session ? `session:${session.id}` : null),
    [session],
  );

  useWebSocket(channel, (ev) => {
    if (ev.type === 'message' && session && ev.sessionId === session.id) {
      setMessages((prev) =>
        prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
      );
    }
    if (ev.type === 'run_status' && session && ev.sessionId === session.id) {
      if (ev.status === 'started') setRunning(true);
      if (ev.status === 'finished' || ev.status === 'error') setRunning(false);
      if (ev.status === 'error' && ev.error) setError(ev.error);
    }
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, running]);

  function handleInputChange(value: string) {
    setInput(value);
    const caret = inputRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = before.match(/@([A-Za-z0-9_-]*)$/);
    if (match) {
      setMentionQuery(match[1]);
    } else {
      setMentionQuery(null);
    }
  }

  function applyMention(item: PlanItem) {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? input.length;
    const before = input.slice(0, caret);
    const after = input.slice(caret);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) return;
    const next = `${before.slice(0, atIdx)}@${item.id} ${after}`;
    setInput(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const cursor = atIdx + item.id.length + 2;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !input.trim()) return;
    const content = input;
    setInput('');
    setMentionQuery(null);
    setError(null);
    setRunning(true);
    try {
      await api.sendMessage(session.id, { content });
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col min-h-0 bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-ink-muted)] flex justify-between">
        <span>Chat · {activePlan ? activePlan.title : 'no plan selected'}</span>
        {session && <span className="font-mono opacity-60">{session.id.slice(0, 8)}</span>}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3 text-sm">
        {messages.length === 0 && (
          <p className="text-[var(--color-ink-muted)]">
            {activePlan
              ? 'Start the conversation. Type @ to tag a plan item.'
              : 'Create a plan to begin.'}
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} items={items} />
        ))}
        {running && (
          <div className="text-xs text-[var(--color-ink-muted)] italic">…thinking</div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>

      <form onSubmit={send} className="relative border-t border-[var(--color-border)] p-3 flex gap-2">
        {mentionQuery !== null && items.length > 0 && (
          <MentionPicker
            items={items}
            query={mentionQuery}
            onSelect={applyMention}
            onClose={() => setMentionQuery(null)}
          />
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyUp={(e) => {
            if (e.key === 'Escape') setMentionQuery(null);
          }}
          placeholder={
            session
              ? running
                ? 'Running…'
                : 'Message the plan (type @ to tag an item)…'
              : 'Create a plan first'
          }
          disabled={!session || running}
          className="flex-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!session || !input.trim() || running}
          className="rounded bg-[var(--color-accent)] text-black px-4 py-2 text-sm disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function MessageBubble({ message, items }: { message: Message; items: PlanItem[] }) {
  const roleStyles: Record<string, string> = {
    user: 'bg-[var(--color-surface-3)] border-[var(--color-border)]',
    assistant: 'bg-[var(--color-surface-2)] border-[var(--color-accent)]',
    system: 'bg-red-500/10 border-red-500/30 text-red-200',
    tool: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-100 font-mono',
  };

  const taggedItem = message.planItemId
    ? items.find((i) => i.id === message.planItemId)
    : null;

  return (
    <div className={`rounded border px-3 py-2 ${roleStyles[message.role] ?? ''}`}>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
        <span>{message.role}</span>
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
      </div>
      {taggedItem && (
        <div className="text-[10px] text-[var(--color-accent)] mb-1">
          tagged → {taggedItem.title}
        </div>
      )}
      <MessageContent content={message.content} items={items} />
    </div>
  );
}
