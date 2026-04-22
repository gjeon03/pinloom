import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronRight, Pin, Send, Square, Terminal, X } from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ToolMessage } from './ToolMessage.js';

interface Props {
  session: Session;
  onPinChange: (message: Message) => void;
}

const BOTTOM_STICKY_PX = 60; // within this distance from bottom → auto-scroll

export function ChatView({ session, onPinChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    setRunning(false);
    setQueue([]);
    setUnseenCount(0);
    setAtBottom(true);
    setStreamingIds(new Set());
    api
      .listMessages(session.id)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((e) => !cancelled && setError(String(e)));
    api
      .getRunStatus(session.id)
      .then((s) => {
        if (!cancelled && s.running) setRunning(true);
      })
      .catch(() => {
        // non-critical
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  useWebSocket(`session:${session.id}`, (ev) => {
    if (ev.type === 'message' && ev.sessionId === session.id) {
      if (ev.message.sourceMessageId) {
        onPinChange(ev.message);
        return;
      }
      setMessages((prev) =>
        prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
      );
      // Empty assistant messages coming in during a run are streaming placeholders
      if (ev.message.role === 'assistant' && ev.message.content === '') {
        setStreamingIds((prev) => {
          const next = new Set(prev);
          next.add(ev.message.id);
          return next;
        });
      }
      if (!atBottom) setUnseenCount((c) => c + 1);
    } else if (ev.type === 'message_updated' && ev.sessionId === session.id) {
      setMessages((prev) =>
        prev.map((m) => (m.id === ev.message.id ? ev.message : m)),
      );
      onPinChange(ev.message);
    } else if (ev.type === 'stream_chunk' && ev.sessionId === session.id) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === ev.messageId ? { ...m, content: m.content + ev.chunk } : m,
        ),
      );
      setStreamingIds((prev) => {
        if (prev.has(ev.messageId)) return prev;
        const next = new Set(prev);
        next.add(ev.messageId);
        return next;
      });
    } else if (ev.type === 'stream_end' && ev.sessionId === session.id) {
      setStreamingIds((prev) => {
        if (!prev.has(ev.messageId)) return prev;
        const next = new Set(prev);
        next.delete(ev.messageId);
        return next;
      });
    } else if (ev.type === 'run_status' && ev.sessionId === session.id) {
      if (ev.status === 'started') {
        setRunning(true);
        setError(null);
      } else {
        setRunning(false);
        // Any stragglers — clear streaming state on run end
        setStreamingIds(new Set());
        if (ev.status === 'error' && ev.error && ev.error !== 'cancelled') {
          setError(ev.error);
        } else {
          setError(null);
        }
      }
    }
  });

  // Track bottom-ness
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < BOTTOM_STICKY_PX;
    setAtBottom(next);
    if (next) setUnseenCount(0);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // initial position
    handleScroll();
  }, [handleScroll, session.id]);

  // Auto-scroll only when user is already near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages.length, running, atBottom]);

  // Textarea auto-grow
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const isShellMode = input.trimStart().startsWith('!');

  async function runMessage(content: string) {
    setError(null);
    if (content.trimStart().startsWith('!')) {
      const command = content.trimStart().slice(1).trim();
      if (!command) return;
      setRunning(true);
      try {
        await api.execShell(session.id, command);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
      return;
    }
    setRunning(true);
    try {
      await api.sendMessage(session.id, { content });
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function send() {
    const content = input.trim();
    if (!content) return;
    if (running || queue.length > 0) {
      // Append to queue — will be sent in order after current run finishes
      setQueue((q) => [...q, content]);
      setInput('');
      return;
    }
    setInput('');
    void runMessage(content);
  }

  // Drain queue: whenever not running and queue has items, pop the first and send
  useEffect(() => {
    if (running) return;
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runMessage(next);
  }, [running, queue]);

  async function cancelRun() {
    if (!running) return;
    setError(null);
    try {
      await api.cancelRun(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!running) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRun();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, session.id]);

  async function togglePin(message: Message) {
    try {
      const updated = await api.updateMessage(message.id, { pinned: !message.pinned });
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      onPinChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseenCount(0);
    setAtBottom(true);
  }

  return (
    <div className="flex flex-col min-h-0 bg-[var(--color-surface)] h-full relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-4 space-y-3 text-sm"
      >
        {messages.length === 0 && (
          <p className="text-[var(--color-ink-muted)]">
            Start the conversation. AI answers can be pinned so they stay visible.
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onTogglePin={togglePin}
            streaming={streamingIds.has(m.id)}
          />
        ))}
        {running && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
            <span className="italic">…thinking</span>
            <button
              type="button"
              onClick={cancelRun}
              title="Cancel (Esc)"
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 hover:border-red-400 hover:text-red-400 text-[11px]"
            >
              <Square size={10} fill="currentColor" />
              <span>Stop</span>
              <span className="opacity-60 text-[10px]">Esc</span>
            </button>
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute left-1/2 -translate-x-1/2 bottom-28 z-10 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border)] shadow-lg px-3 py-1.5 text-xs flex items-center gap-1.5 hover:border-[var(--color-accent)]"
        >
          <ArrowDown size={12} />
          {unseenCount > 0 ? (
            <span>
              {unseenCount} new
            </span>
          ) : (
            <span>Jump to latest</span>
          )}
        </button>
      )}

      {queue.length > 0 && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/80">
          <div className="px-3 py-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">
            <span>Queued ({queue.length})</span>
            {queue.length > 1 && (
              <button
                type="button"
                onClick={() => setQueue([])}
                className="hover:text-red-400"
              >
                Clear all
              </button>
            )}
          </div>
          <ul className="max-h-32 overflow-auto">
            {queue.map((msg, i) => (
              <li
                key={i}
                className="px-3 py-1 text-xs flex items-center gap-2 border-t border-[var(--color-border)]/60"
              >
                <ChevronRight size={12} className="text-[var(--color-accent)] shrink-0" />
                <span className="flex-1 truncate text-[var(--color-ink)]/90">{msg}</span>
                <button
                  type="button"
                  onClick={() => {
                    setInput(msg);
                    setQueue((q) => q.filter((_, j) => j !== i));
                  }}
                  className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] text-[11px]"
                  title="Move back to input to edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setQueue((q) => q.filter((_, j) => j !== i))}
                  title="Remove from queue"
                  className="text-[var(--color-ink-muted)] hover:text-red-400 p-0.5"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-[var(--color-border)] p-3 flex gap-2 items-end"
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            running
              ? 'Type to queue — will send after the current response…'
              : 'Message the AI (Shift+Enter for newline · start with ! to run a shell command)'
          }
          rows={1}
          className={`flex-1 resize-none rounded border px-3 py-2 text-sm leading-snug ${
            isShellMode
              ? 'bg-yellow-500/10 border-yellow-500/40 font-mono text-yellow-100'
              : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'
          }`}
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className={`rounded px-3 py-2 text-sm disabled:opacity-40 font-medium flex items-center gap-1.5 ${
            isShellMode
              ? 'bg-yellow-400 text-black'
              : 'bg-[var(--color-accent)] text-black'
          }`}
        >
          {isShellMode ? <Terminal size={14} /> : <Send size={14} />}
          <span>{running ? 'Queue' : isShellMode ? 'Run' : 'Send'}</span>
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  onTogglePin,
  streaming,
}: {
  message: Message;
  onTogglePin: (m: Message) => void;
  streaming: boolean;
}) {
  const roleStyles: Record<string, string> = {
    user: 'bg-[var(--color-surface-3)] border-[var(--color-border)]',
    assistant: 'bg-[var(--color-surface-2)] border-[var(--color-accent)]',
    system: 'bg-red-500/10 border-red-500/30 text-red-200',
    tool: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-100 font-mono',
  };

  const canPin = (message.role === 'assistant' || message.role === 'user') && !streaming;

  return (
    <div className={`group rounded border px-3 py-2 ${roleStyles[message.role] ?? ''}`}>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
        <span>{message.role}</span>
        <div className="flex items-center gap-2">
          <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
          {canPin && (
            <button
              onClick={() => onTogglePin(message)}
              title={message.pinned ? 'Unpin' : 'Pin'}
              className={`p-0.5 rounded transition-opacity ${
                message.pinned
                  ? 'text-[var(--color-accent)]'
                  : 'opacity-0 group-hover:opacity-100 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]'
              }`}
            >
              <Pin size={12} fill={message.pinned ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      </div>
      {message.role === 'tool' ? (
        <ToolMessage message={message} />
      ) : (
        <div className="whitespace-pre-wrap text-sm">
          {message.content}
          {streaming && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-[var(--color-ink-muted)] animate-pulse" />
          )}
        </div>
      )}
    </div>
  );
}
