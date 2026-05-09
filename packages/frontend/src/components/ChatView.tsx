import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  BookPlus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ImagePlus,
  Pin,
  Send,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type { AgentKind, Message, QueueItem, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ToolMessage } from './ToolMessage.js';
import { ToolGroup } from './ToolGroup.js';
import { Tooltip } from './Tooltip.js';
import { ModelPicker, findModelLabel } from './ModelPicker.js';
import { AgentBadge } from './AgentBadge.js';
import { useNotifications } from '../stores/notifications.js';

type AiRunState = 'ai' | null;

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

const THINKING_VERBS = [
  'Thinking',
  'Pondering',
  'Brewing',
  'Hyperspacing',
  'Cooking',
  'Hatching',
  'Weaving',
  'Crunching',
  'Noodling',
  'Untangling',
  'Composing',
  'Divining',
  'Musing',
  'Incubating',
  'Reticulating',
];

function pickVerb(current?: string): string {
  if (THINKING_VERBS.length <= 1) return THINKING_VERBS[0];
  while (true) {
    const v = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    if (v !== current) return v;
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

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

type RenderItem =
  | { kind: 'message'; message: Message }
  | { kind: 'tool-group'; key: string; messages: Message[] };

function groupConsecutiveTools(messages: Message[]): RenderItem[] {
  const out: RenderItem[] = [];
  let buffer: Message[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    out.push({ kind: 'tool-group', key: `tools-${buffer[0].id}`, messages: buffer });
    buffer = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') buffer.push(m);
    else {
      flush();
      out.push({ kind: 'message', message: m });
    }
  }
  flush();
  return out;
}

interface Props {
  session: Session;
  onPinChange: (message: Message) => void;
}

const BOTTOM_STICKY_PX = 60; // within this distance from bottom → auto-scroll

// Per-session textarea draft survives tab/project switch via sessionStorage.
// The pending message queue lives entirely in the backend now (see
// /api/sessions/:id/queue) so it survives backend restarts and mirrors
// across any client viewing the same session.
const inputKey = (sessionId: string) => `pinloom:input:${sessionId}`;

function loadPersistedInput(sessionId: string): string {
  try {
    return sessionStorage.getItem(inputKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function ChatView({ session, onPinChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => loadPersistedInput(session.id));
  const [runKind, setRunKind] = useState<AiRunState>(null);
  const [shellRunning, setShellRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [runStartAt, setRunStartAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [verb, setVerb] = useState<string>(() => pickVerb());
  const [thinkingText, setThinkingText] = useState<string>('');
  const [wikiSyncing, setWikiSyncing] = useState(false);
  const [model, setModel] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(`pinloom:model:${session.id}`);
      return raw === '' || raw === null ? null : raw;
    } catch {
      return null;
    }
  });
  const [showModelRow, setShowModelRow] = useState<boolean>(() => {
    try {
      // Default is expanded — first-time users discover the picker, then can collapse.
      return localStorage.getItem('pinloom:showModelRow') !== '0';
    } catch {
      return true;
    }
  });
  const notifications = useNotifications();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueScrollRef = useRef<HTMLUListElement>(null);
  const nextAttachmentNumberRef = useRef(1);

  const aiRunning = runKind === 'ai';
  const running = aiRunning || shellRunning;

  // Persist textarea draft per-session. The component remounts on session
  // switch (key={session.id}), so without this the in-progress draft
  // disappears when the user changes tabs or projects. Queue items live
  // on the backend and arrive via WS, so they don't need this treatment.
  useEffect(() => {
    try {
      if (input.length > 0) sessionStorage.setItem(inputKey(session.id), input);
      else sessionStorage.removeItem(inputKey(session.id));
    } catch {
      // sessionStorage unavailable (private mode etc.) — drafts won't
      // survive then but the chat still works.
    }
  }, [input, session.id]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    setRunKind(null);
    setShellRunning(false);
    // Don't clear input or queue here: they were loaded from localStorage
    // by the useState initializer for this session and we want them to
    // survive the mount-time reset of derived state below.
    setUnseenCount(0);
    setAtBottom(true);
    setStreamingIds(new Set());
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return [];
    });
    setRunStartAt(null);
    setElapsedSec(0);
    setThinkingText('');
    nextAttachmentNumberRef.current = 1;
    nextAttachmentNumberRef.current = session.nextImageNumber;
    try {
      const raw = localStorage.getItem(`pinloom:model:${session.id}`);
      setModel(raw === '' || raw === null ? null : raw);
    } catch {
      setModel(null);
    }
    api
      .listMessages(session.id)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
      })
      .catch((e) => !cancelled && setError(String(e)));
    api
      .listQueue(session.id)
      .then((items) => {
        if (cancelled) return;
        setQueue(items);
      })
      .catch(() => {
        // Best-effort initial fetch — WS will keep us in sync from here.
      });
    api
      .getRunStatus(session.id)
      .then((s) => {
        if (cancelled) return;
        if (s.ai) setRunKind('ai');
        if (s.exec) setShellRunning(true);
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
    } else if (ev.type === 'thinking_start' && ev.sessionId === session.id) {
      setThinkingText('');
    } else if (ev.type === 'thinking_chunk' && ev.sessionId === session.id) {
      setThinkingText((prev) => prev + ev.chunk);
    } else if (ev.type === 'queue_updated' && ev.sessionId === session.id) {
      // Backend owns the queue; just mirror it.
      setQueue(ev.items);
    } else if (ev.type === 'run_status' && ev.sessionId === session.id) {
      if (ev.status === 'started') {
        setRunKind('ai');
        setError(null);
        setRunStartAt(Date.now());
        setElapsedSec(0);
        setVerb(pickVerb());
        setThinkingText('');
      } else {
        setRunKind((prev) => (prev === 'ai' ? null : prev));
        setRunStartAt(null);
        setThinkingText('');
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

  // Keep the latest content anchored when the chat area shrinks — e.g. while
  // the user types and the textarea grows, pushing the bottom up.
  const atBottomRef = useRef(true);
  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // Textarea auto-grow.
  // When the input is empty we DON'T compute height from scrollHeight, because
  // a wrapping placeholder inflates scrollHeight and leaves the textarea stuck
  // at multi-row height. Falling back to the rows={1} default keeps it tight.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = '';
      return;
    }
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

  async function runShellCommand(content: string) {
    const command = content.trimStart().slice(1).trim();
    if (!command) return;
    setError(null);
    setShellRunning(true);
    try {
      await api.execShell(session.id, command);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setShellRunning(false);
    }
  }

  async function runMessage(content: string, atts: Attachment[] = []) {
    setError(null);

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
        model: model ?? undefined,
      });
    } catch (err) {
      setRunKind((prev) => (prev === 'ai' ? null : prev));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function send() {
    const content = input.trim();
    if (!content && attachments.length === 0) return;

    // Shell commands (!) bypass the queue — they run as independent child
    // processes and can execute in parallel with an ongoing AI response.
    if (content.startsWith('!')) {
      setInput('');
      void runShellCommand(content);
      return;
    }

    // Image attachments still take the direct send path — the backend
    // queue table holds plain text only, and quietly losing images on
    // queue-then-drain would be worse UX than blocking the send.
    if (attachments.length > 0) {
      if (aiRunning || queue.length > 0) {
        setError('Finish the current run before sending images.');
        return;
      }
      const atts = attachments;
      setInput('');
      setAttachments([]);
      void runMessage(content, atts);
      return;
    }

    // Default path: enqueue. The backend drains at every turn boundary,
    // so an enqueue against an idle agent immediately starts a new run,
    // and an enqueue against a running agent holds until the next break
    // — both transparently to the caller.
    setError(null);
    setInput('');
    void api
      .enqueueMessage(session.id, {
        content,
        model: model ?? null,
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }

  // Keep the queue panel pinned to its top so the "next up" item stays visible.
  useEffect(() => {
    const el = queueScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [queue.length]);

  // Elapsed-time + occasional verb rotation while the AI is thinking.
  useEffect(() => {
    if (runStartAt === null) return;
    const id = setInterval(() => {
      const sec = Math.floor((Date.now() - runStartAt) / 1000);
      setElapsedSec(sec);
      if (sec > 0 && sec % 12 === 0) {
        setVerb((prev) => pickVerb(prev));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [runStartAt]);

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

  function changeModel(next: string | null) {
    setModel(next);
    try {
      if (next === null) localStorage.removeItem(`pinloom:model:${session.id}`);
      else localStorage.setItem(`pinloom:model:${session.id}`, next);
    } catch {
      // ignore
    }
  }

  function toggleModelRow() {
    setShowModelRow((v) => {
      const next = !v;
      try {
        localStorage.setItem('pinloom:showModelRow', next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }

  async function syncWiki() {
    if (wikiSyncing) return;
    setWikiSyncing(true);
    const notifId = notifications.start({
      kind: 'wiki-sync',
      title: 'Wiki sync',
      meta: { sessionId: session.id, sessionTitle: session.title },
    });
    try {
      const result = await api.syncWiki(session.id);
      notifications.resolve(notifId, result.output);
    } catch (err) {
      notifications.fail(
        notifId,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setWikiSyncing(false);
    }
  }

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
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
          Chat
        </span>
        <div className="flex items-center gap-1">
          <Tooltip
            label={wikiSyncing ? 'Syncing to wiki…' : 'Sync this session to wiki'}
            side="bottom"
          >
            <button
              type="button"
              onClick={syncWiki}
              disabled={wikiSyncing}
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <BookPlus size={14} className={wikiSyncing ? 'animate-pulse' : ''} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="flex-1 min-h-0 relative flex flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 text-sm"
      >
        <div className="h-4" aria-hidden />
        <div className="space-y-3">
        {messages.length === 0 && (
          <p className="text-[var(--color-ink-muted)]">
            Start the conversation. AI answers can be pinned so they stay visible.
          </p>
        )}
        {groupConsecutiveTools(messages).map((item) => {
          if (item.kind === 'tool-group') {
            return <ToolGroup key={item.key} messages={item.messages} />;
          }
          const m = item.message;
          return (
            <MessageBubble
              key={m.id}
              message={m}
              sessionAgent={session.agent}
              onTogglePin={togglePin}
              streaming={streamingIds.has(m.id)}
            />
          );
        })}
        {aiRunning && streamingIds.size === 0 && (
          <div className="text-xs text-[var(--color-ink-muted)] space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="italic">
                {verb}…
                {elapsedSec > 0 && (
                  <span className="not-italic opacity-70"> ({formatElapsed(elapsedSec)})</span>
                )}
              </span>
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
            {thinkingText.trim().length > 0 && (
              <div className="relative pl-4 border-l-2 border-[var(--color-border)] opacity-70 max-h-24 overflow-hidden flex items-end">
                {/* Subtle fade so the top edge looks intentional rather than abruptly clipped */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 left-0 right-0 h-3 bg-gradient-to-b from-[var(--color-surface)] to-transparent"
                />
                <div className="whitespace-pre-wrap w-full">
                  {thinkingText.slice(-1500)}
                </div>
              </div>
            )}
          </div>
        )}
        {shellRunning && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-tool-ink)] font-mono">
            <span>$ running…</span>
            <button
              type="button"
              onClick={cancelRun}
              title="Cancel"
              className="inline-flex items-center gap-1 rounded border border-[var(--color-tool-border)] px-2 py-0.5 hover:border-red-400 hover:text-red-400 text-[11px]"
            >
              <Square size={10} fill="currentColor" />
              <span>Stop</span>
            </button>
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
        <div className="h-4" aria-hidden />
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
                onClick={() => {
                  // Remove every queued item one by one. Backend broadcasts
                  // queue_updated after each delete, so the UI updates as
                  // they drop.
                  for (const item of queue) {
                    void api.removeQueueItem(session.id, item.id).catch(() => {});
                  }
                }}
                className="hover:text-red-400"
              >
                Clear all
              </button>
            )}
          </div>
          <ul ref={queueScrollRef} className="max-h-32 overflow-auto">
            {queue.map((item) => (
              <li
                key={item.id}
                className="px-3 py-1 text-xs flex items-center gap-2 border-t border-[var(--color-border)]/60"
              >
                <ChevronRight size={12} className="text-[var(--color-accent)] shrink-0" />
                <span className="flex-1 truncate text-[var(--color-ink)]/90">
                  {item.content}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setInput(item.content);
                    void api
                      .removeQueueItem(session.id, item.id)
                      .catch(() => {});
                  }}
                  className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] text-[11px]"
                  title="Move back to input to edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void api.removeQueueItem(session.id, item.id).catch(() => {})
                  }
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
            disabled={isShellMode || aiRunning}
            className="shrink-0 h-9 w-9 flex items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
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
              isShellMode
                ? 'Shell command — runs immediately, even during an AI response'
                : aiRunning || queue.length > 0
                  ? 'Type to queue — will send after the current response…'
                  : 'Message the AI (Shift+Enter for newline · paste/attach images · start with ! to run a shell command)'
            }
            rows={1}
            className={`flex-1 resize-none rounded border px-3 py-2 text-sm leading-snug ${
              isShellMode
                ? 'bg-[var(--color-tool-bg)] border-[var(--color-tool-border)] font-mono text-[var(--color-tool-ink)]'
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
            <span>
              {isShellMode
                ? 'Run'
                : aiRunning || queue.length > 0
                  ? 'Queue'
                  : 'Send'}
            </span>
          </button>
        </div>
        {!isShellMode && (
          <div className="border-t border-[var(--color-border)]/60 -mx-3 -mb-3 px-3">
            {showModelRow && (
              <div className="py-2 flex items-center justify-between gap-2 text-[11px] text-[var(--color-ink-muted)]">
                <div className="flex items-center gap-2">
                  <span>Model</span>
                  <ModelPicker
                    value={model}
                    onChange={changeModel}
                    side="top"
                    disabled={aiRunning}
                  />
                </div>
                {/* Reserved space for future composer-level controls. */}
              </div>
            )}
            <button
              type="button"
              onClick={toggleModelRow}
              title={showModelRow ? 'Collapse' : 'Expand'}
              className={`w-full flex items-center justify-center text-[var(--color-ink-muted)]/60 hover:text-[var(--color-accent)] ${
                showModelRow ? 'py-1' : 'py-0.5'
              }`}
            >
              {showModelRow ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  sessionAgent,
  onTogglePin,
  streaming,
}: {
  message: Message;
  sessionAgent: AgentKind;
  onTogglePin: (m: Message) => void;
  streaming: boolean;
}) {
  const roleBg: Record<string, string> = {
    user: 'bg-[var(--color-surface-3)]',
    assistant: 'bg-[var(--color-surface-2)]',
    system: 'bg-[var(--color-error-bg)]',
    tool: 'bg-[var(--color-tool-bg)]',
  };
  const roleFrame: Record<string, string> = {
    user: 'border-[var(--color-border)]',
    assistant: 'border-[var(--color-accent)]',
    system: 'border-[var(--color-error-border)] text-[var(--color-error-ink)]',
    tool: 'border-[var(--color-tool-border)] text-[var(--color-tool-ink)] font-mono',
  };

  const canPin = (message.role === 'assistant' || message.role === 'user') && !streaming;
  // Tool/system messages are typically short and not pin targets — sticky there
  // just adds visual noise as it follows the scroll. Limit sticky to user/assistant.
  const stickyHeader = message.role === 'assistant' || message.role === 'user';

  return (
    <div
      className={`group rounded border ${roleBg[message.role] ?? ''} ${
        roleFrame[message.role] ?? ''
      }`}
    >
      <div
        className={`${stickyHeader ? 'sticky top-0 z-10' : ''} flex justify-between items-center px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] rounded-t border-b border-[var(--color-border)]/30 ${
          roleBg[message.role] ?? ''
        }`}
      >
        <span className="flex items-center gap-1.5">
          {message.role === 'assistant' && (
            <AgentBadge agent={sessionAgent} size="xs" />
          )}
          {message.role}
        </span>
        <div className="flex items-center gap-2">
          {message.role === 'assistant' && message.model && (
            <span
              title={message.model}
              className="rounded border border-[var(--color-border)] px-1 py-0 normal-case tracking-normal text-[10px] text-[var(--color-ink-muted)]"
            >
              {findModelLabel(message.model)}
            </span>
          )}
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
      <div className="px-3 py-2 min-w-0">
        {message.role === 'tool' ? (
          <ToolMessage message={message} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm">
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
