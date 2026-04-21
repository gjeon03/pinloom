import { useEffect, useRef, useState } from 'react';
import { Pin, Send, Square, Terminal } from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ToolMessage } from './ToolMessage.js';

interface Props {
  session: Session;
  onPinChange: (message: Message) => void;
}

export function ChatView({ session, onPinChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    api
      .listMessages(session.id)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  useWebSocket(`session:${session.id}`, (ev) => {
    if (ev.type === 'message' && ev.sessionId === session.id) {
      // Copied pins (sourceMessageId set) go only to the pinned panel, not chat.
      if (ev.message.sourceMessageId) {
        onPinChange(ev.message);
        return;
      }
      setMessages((prev) =>
        prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
      );
    } else if (ev.type === 'message_updated' && ev.sessionId === session.id) {
      setMessages((prev) =>
        prev.map((m) => (m.id === ev.message.id ? ev.message : m)),
      );
      onPinChange(ev.message);
    } else if (ev.type === 'run_status' && ev.sessionId === session.id) {
      if (ev.status === 'started') setRunning(true);
      else {
        setRunning(false);
        if (ev.status === 'error' && ev.error) setError(ev.error);
      }
    }
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, running]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const isShellMode = input.trimStart().startsWith('!');

  async function send() {
    if (!input.trim() || running) return;
    const content = input;
    setInput('');
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

  async function cancelRun() {
    if (!running) return;
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

  return (
    <div className="flex flex-col min-h-0 bg-[var(--color-surface)] h-full">
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3 text-sm">
        {messages.length === 0 && (
          <p className="text-[var(--color-ink-muted)]">
            Start the conversation. AI answers can be pinned 📌 so they stay visible.
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onTogglePin={togglePin} />
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
              ? 'Running…'
              : 'Message the AI (Shift+Enter for newline · start with ! to run a shell command)'
          }
          disabled={running}
          rows={1}
          className={`flex-1 resize-none rounded border px-3 py-2 text-sm disabled:opacity-50 leading-snug ${
            isShellMode
              ? 'bg-yellow-500/10 border-yellow-500/40 font-mono text-yellow-100'
              : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'
          }`}
        />
        <button
          type="submit"
          disabled={!input.trim() || running}
          className={`rounded px-3 py-2 text-sm disabled:opacity-40 font-medium flex items-center gap-1.5 ${
            isShellMode
              ? 'bg-yellow-400 text-black'
              : 'bg-[var(--color-accent)] text-black'
          }`}
        >
          {isShellMode ? <Terminal size={14} /> : <Send size={14} />}
          <span>{isShellMode ? 'Run' : 'Send'}</span>
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  onTogglePin,
}: {
  message: Message;
  onTogglePin: (m: Message) => void;
}) {
  const roleStyles: Record<string, string> = {
    user: 'bg-[var(--color-surface-3)] border-[var(--color-border)]',
    assistant: 'bg-[var(--color-surface-2)] border-[var(--color-accent)]',
    system: 'bg-red-500/10 border-red-500/30 text-red-200',
    tool: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-100 font-mono',
  };

  const canPin = message.role === 'assistant' || message.role === 'user';

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
        <div className="whitespace-pre-wrap text-sm">{message.content}</div>
      )}
    </div>
  );
}
