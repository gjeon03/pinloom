import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ChevronRight,
  ImagePlus,
  Pin,
  Send,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ToolMessage } from './ToolMessage.js';

type RunKind = 'ai' | 'shell' | null;

type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set<SupportedImageMime>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface Attachment {
  id: string;
  number: number;
  file: File;
  mimeType: SupportedImageMime;
  previewUrl: string;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

interface Props {
  session: Session;
  onPinChange: (message: Message) => void;
}

const BOTTOM_STICKY_PX = 60; // within this distance from bottom → auto-scroll

export function ChatView({ session, onPinChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [runKind, setRunKind] = useState<RunKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueScrollRef = useRef<HTMLUListElement>(null);
  const nextAttachmentNumberRef = useRef(1);

  const running = runKind !== null;

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    setRunKind(null);
    setQueue([]);
    setUnseenCount(0);
    setAtBottom(true);
    setStreamingIds(new Set());
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return [];
    });
    nextAttachmentNumberRef.current = 1;
    nextAttachmentNumberRef.current = session.nextImageNumber;
    api
      .listMessages(session.id)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
      })
      .catch((e) => !cancelled && setError(String(e)));
    api
      .getRunStatus(session.id)
      .then((s) => {
        if (cancelled) return;
        if (s.ai) setRunKind('ai');
        else if (s.exec) setRunKind('shell');
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
        setRunKind('ai');
        setError(null);
      } else {
        setRunKind((prev) => (prev === 'ai' ? null : prev));
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

  // Auto-scroll only when user is already near bottom.
  // Depends on full `messages` array so streaming content growth (same
  // length, content changes) also triggers the scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, running, atBottom, queue.length, attachments.length]);

  // Textarea auto-grow
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const isShellMode = input.trimStart().startsWith('!');

  function addAttachmentFiles(files: File[]): Attachment[] {
    const accepted = files.filter((f): f is File => SUPPORTED_MIME_TYPES.has(f.type));
    if (accepted.length === 0) {
      if (files.length > 0) {
        setError('Only JPEG, PNG, GIF, or WebP images are supported.');
      }
      return [];
    }
    const tooBig = accepted.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig) {
      setError(`Image too large: ${tooBig.name} (max 5MB)`);
      return [];
    }
    const startNumber = nextAttachmentNumberRef.current;
    const added: Attachment[] = accepted.map((file, i) => ({
      id: `att-${Math.random().toString(36).slice(2, 10)}`,
      number: startNumber + i,
      file,
      mimeType: file.type as SupportedImageMime,
      previewUrl: URL.createObjectURL(file),
    }));
    nextAttachmentNumberRef.current = startNumber + added.length;
    setAttachments((prev) => [...prev, ...added]);
    return added;
  }

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) {
      setInput((prev) => (prev.length > 0 ? `${prev}${text}` : text));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = `${before}${text}${after}`;
    setInput(next);
    const pos = start + text.length;
    // Run after React commits so selectionRange targets the new value length.
    setTimeout(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(pos, pos);
    }, 0);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  useEffect(() => {
    return () => {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runMessage(content: string, atts: Attachment[] = []) {
    setError(null);
    if (content.trimStart().startsWith('!')) {
      const command = content.trimStart().slice(1).trim();
      if (!command) return;
      setRunKind('shell');
      try {
        await api.execShell(session.id, command);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunKind((prev) => (prev === 'shell' ? null : prev));
      }
      return;
    }

    let imagesPayload: { mimeType: SupportedImageMime; base64: string }[] = [];
    if (atts.length > 0) {
      setUploadingAttachments(true);
      try {
        imagesPayload = await Promise.all(
          [...atts]
            .sort((a, b) => a.number - b.number)
            .map(async (a) => ({
              mimeType: a.mimeType,
              base64: await blobToBase64(a.file),
            })),
        );
        atts.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setUploadingAttachments(false);
        return;
      } finally {
        setUploadingAttachments(false);
      }
    }

    setRunKind('ai');
    try {
      await api.sendMessage(session.id, {
        content,
        images: imagesPayload.length > 0 ? imagesPayload : undefined,
      });
    } catch (err) {
      setRunKind((prev) => (prev === 'ai' ? null : prev));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function send() {
    const content = input.trim();
    if (!content && attachments.length === 0) return;
    if (running || queue.length > 0) {
      // Attachments are not supported in queued messages — require the first
      // run to complete before stacking more. Only queue plain text.
      if (attachments.length > 0) {
        setError('Finish the current run before sending images.');
        return;
      }
      setQueue((q) => [...q, content]);
      setInput('');
      return;
    }
    const atts = attachments;
    setInput('');
    setAttachments([]);
    // Do not reset nextAttachmentNumberRef — numbering continues across the
    // whole session so "[Image #N]" references stay unique in the transcript.
    void runMessage(content, atts);
  }

  // Drain queue: whenever not running and queue has items, pop the first and send
  useEffect(() => {
    if (running) return;
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runMessage(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, queue]);

  // Keep the queue panel pinned to its top so the "next up" item stays visible.
  useEffect(() => {
    const el = queueScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [queue.length]);

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
    <div className="flex flex-col min-h-0 bg-[var(--color-surface)] h-full">
      <div className="flex-1 min-h-0 relative flex flex-col">
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
        {runKind === 'ai' && (
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
        {runKind === 'shell' && (
          <div className="flex items-center gap-2 text-xs text-yellow-300/80 font-mono">
            <span>$ running…</span>
            <button
              type="button"
              onClick={cancelRun}
              title="Cancel (Esc)"
              className="inline-flex items-center gap-1 rounded border border-yellow-500/40 px-2 py-0.5 hover:border-red-400 hover:text-red-400 text-[11px]"
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
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border)] shadow-lg px-3 py-1.5 text-xs flex items-center gap-1.5 hover:border-[var(--color-accent)]"
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
      </div>

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
          <ul ref={queueScrollRef} className="max-h-32 overflow-auto">
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
        className="border-t border-[var(--color-border)] p-3 flex flex-col gap-2"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="relative group rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] overflow-hidden"
              >
                <img
                  src={a.previewUrl}
                  alt={a.file.name}
                  className="h-16 w-16 object-cover"
                />
                <span className="absolute bottom-0.5 left-0.5 bg-black/70 text-white rounded px-1 text-[10px] font-mono leading-tight">
                  #{a.number}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  title="Remove"
                  className="absolute top-0.5 right-0.5 bg-black/70 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {uploadingAttachments && (
              <span className="self-center text-[11px] text-[var(--color-ink-muted)] italic">
                preparing…
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              addAttachmentFiles(files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image (or paste from clipboard)"
            disabled={isShellMode || running}
            className="shrink-0 rounded border border-[var(--color-border)] p-2 text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ImagePlus size={14} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (isShellMode) return;
              const items = Array.from(e.clipboardData?.items ?? []);
              const images = items
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => f != null);
              if (images.length > 0) {
                e.preventDefault();
                const added = addAttachmentFiles(images);
                if (added.length > 0) {
                  const placeholder = added
                    .map((a) => `[Image #${a.number}]`)
                    .join(' ');
                  insertAtCursor(placeholder);
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              running
                ? 'Type to queue — will send after the current response…'
                : 'Message the AI (Shift+Enter for newline · paste/attach images · start with ! to run a shell command)'
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
            disabled={(!input.trim() && attachments.length === 0) || uploadingAttachments}
            className={`rounded px-3 py-2 text-sm disabled:opacity-40 font-medium flex items-center gap-1.5 ${
              isShellMode
                ? 'bg-yellow-400 text-black'
                : 'bg-[var(--color-accent)] text-black'
            }`}
          >
            {isShellMode ? <Terminal size={14} /> : <Send size={14} />}
            <span>{running ? 'Queue' : isShellMode ? 'Run' : 'Send'}</span>
          </button>
        </div>
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
  const roleBg: Record<string, string> = {
    user: 'bg-[var(--color-surface-3)]',
    assistant: 'bg-[var(--color-surface-2)]',
    system: 'bg-red-500/10',
    tool: 'bg-yellow-500/10',
  };
  const roleFrame: Record<string, string> = {
    user: 'border-[var(--color-border)]',
    assistant: 'border-[var(--color-accent)]',
    system: 'border-red-500/30 text-red-200',
    tool: 'border-yellow-500/30 text-yellow-100 font-mono',
  };

  const canPin = (message.role === 'assistant' || message.role === 'user') && !streaming;

  return (
    <div
      className={`group rounded border ${roleBg[message.role] ?? ''} ${
        roleFrame[message.role] ?? ''
      }`}
    >
      <div
        className={`sticky top-0 z-10 flex justify-between items-center px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] rounded-t border-b border-[var(--color-border)]/30 ${
          roleBg[message.role] ?? ''
        }`}
      >
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
      <div className="px-3 py-2">
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
    </div>
  );
}
