import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import useSWR from 'swr';
import {
  ArrowDown,
  BookPlus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ImagePlus,
  Minus,
  Plus,
  RotateCw,
  Send,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type {
  AgentKind,
  Message,
  QueueItem,
  Session,
} from '@pinloom/shared';
import { api } from '../api/client.js';
import { cacheKeys } from '../api/cacheKeys.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { ToolMessage } from './ToolMessage.js';
import { ToolGroup } from './ToolGroup.js';
import { Tooltip } from './Tooltip.js';
import { ModelPicker, findModelLabel } from './ModelPicker.js';
import { EffortPicker } from './EffortPicker.js';
import { AgentBadge } from './AgentBadge.js';
import { MentionPopup, type MentionWorker } from './MentionPopup.js';
import { useNotifications } from '../stores/notifications.js';
import { Markdown } from './Markdown.js';
import {
  CopyMarkdownButton,
  DownloadMarkdownButton,
  PinToggleButton,
  RawViewToggle,
} from './MessageActions.js';

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

// Anthropic rejects images over 2000px on the long edge once a request
// carries many images, and downscales anything past ~1568px server-side
// regardless. Cap on the long edge before sending so a single high-res
// screenshot can't make a whole multi-image session unsendable. Images
// already under the cap pass through untouched (preserves quality and GIF
// animation); only oversized ones are re-encoded.
const MAX_IMAGE_DIMENSION = 1568;

async function imageToPayload(
  file: Blob,
  mimeType: SupportedImageMime,
): Promise<{ mimeType: SupportedImageMime; base64: string }> {
  const passthrough = async () => ({ mimeType, base64: await blobToBase64(file) });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return passthrough();
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= MAX_IMAGE_DIMENSION) return passthrough();

    const scale = MAX_IMAGE_DIMENSION / longEdge;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cctx = canvas.getContext('2d');
    if (!cctx) return passthrough();
    cctx.drawImage(bitmap, 0, 0, w, h);

    // Canvas can't re-encode GIF and an oversized GIF loses animation when
    // resized anyway, so emit lossless PNG (also a backend-accepted mime).
    const outMime: SupportedImageMime = mimeType === 'image/gif' ? 'image/png' : mimeType;
    const quality =
      outMime === 'image/jpeg' || outMime === 'image/webp' ? 0.9 : undefined;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), outMime, quality),
    );
    if (!blob) return passthrough();
    return { mimeType: outMime, base64: await blobToBase64(blob) };
  } finally {
    bitmap.close();
  }
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
  onSessionUpdate?: (session: Session) => void;
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

export function ChatView({ session, onPinChange, onSessionUpdate }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  // groupConsecutiveTools is O(N) over the whole message list. Without
  // memoization every `stream_chunk` event (~10/sec while a turn is
  // streaming) re-runs it and produces a new array, which combined with
  // an un-memoized MessageBubble forces a full reconciliation of every
  // row. Memoizing here means only adds/updates trigger a re-group, and
  // identical messages keep their row instances.
  const renderItems = useMemo(() => groupConsecutiveTools(messages), [messages]);
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
  // Model + Effort live on the session row in the DB, so they survive
  // the GitHub backup → other-machine import path. Local state mirrors
  // the session prop and writes back through PATCH /api/sessions/:id.
  const [model, setModel] = useState<string | null>(session.model);
  const [effort, setEffort] = useState<Session['reasoningEffort']>(
    session.reasoningEffort,
  );
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

  // Per-session chat text zoom (independent of app/browser zoom), mirroring the
  // terminal's +/- control. Drives the --chat-font-size CSS var the message
  // bubbles read, so scaling never re-renders the message list.
  const chatFontKey = `pinloom:chatFontSize:${session.id}`;
  const [chatFontSize, setChatFontSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(chatFontKey));
      return v >= 11 && v <= 24 ? v : 14;
    } catch {
      return 14;
    }
  });
  const changeChatFontSize = useCallback(
    (delta: number) => {
      setChatFontSize((prev) => {
        const next = Math.max(11, Math.min(24, prev + delta));
        if (next !== prev) {
          try {
            localStorage.setItem(chatFontKey, String(next));
          } catch {
            // localStorage unavailable; the change still applies this session
          }
        }
        return next;
      });
    },
    [chatFontKey],
  );

  // Mention autocomplete: fetch the team this session orchestrates (if
  // any) so we can suggest workers when the user types "@". Goes through
  // SWR so multiple ChatView instances share one inflight per endpoint
  // (raw fetches previously bypassed dedupingInterval and stacked up on
  // every `pinloom:teams-changed` event). sessions/projects are gated
  // behind `team` — most sessions aren't orchestrators and don't need
  // them at all. The window event is now handled centrally in App.tsx,
  // which calls `mutate(cacheKeys.teams())` to refresh every subscriber
  // in one shared fetch.
  // Fetchers are wrapped in arrow functions because SWR invokes the
  // fetcher with the key tuple as its first argument — passing the raw
  // `api.listTeams` would (silently today, loudly tomorrow if the signature
  // grows options) hand `['teams']` to the API client.
  const { data: teams = [] } = useSWR(cacheKeys.teams(), () => api.listTeams());
  const team = useMemo(
    () => teams.find((t) => t.orchestratorSessionId === session.id) ?? null,
    [teams, session.id],
  );
  const { data: allSessionsForMentions } = useSWR(
    team ? cacheKeys.allSessions() : null,
    () => api.listAllSessions(),
  );
  const { data: projectsForMentions } = useSWR(
    team ? cacheKeys.projects() : null,
    () => api.listProjects(),
  );
  const mentionWorkers = useMemo<MentionWorker[]>(() => {
    if (!team || !allSessionsForMentions || !projectsForMentions) return [];
    const sessionsById = new Map(allSessionsForMentions.map((s) => [s.id, s]));
    const projectsById = new Map(projectsForMentions.map((p) => [p.id, p]));
    return team.members.map((m) => {
      const s = sessionsById.get(m.sessionId) ?? null;
      const project = s ? projectsById.get(s.projectId) : null;
      return {
        member: m,
        session: s,
        projectName: project?.name ?? null,
      };
    });
  }, [team, allSessionsForMentions, projectsForMentions]);

  // Mention popup state. `range` is the [start, end) span in `input`
  // currently being mentioned; `query` is the lowercased text after the
  // "@". Null when no popup should be visible.
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const filteredMentions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionWorkers.filter((w) =>
      w.member.alias.toLowerCase().startsWith(q),
    );
  }, [mention, mentionWorkers]);

  // Keep the highlight in bounds as the filter shrinks.
  useEffect(() => {
    if (mentionIndex >= filteredMentions.length) {
      setMentionIndex(Math.max(0, filteredMentions.length - 1));
    }
  }, [filteredMentions, mentionIndex]);

  function detectMentionAtCursor(value: string, cursor: number) {
    // Walk back from the cursor to find a "@" preceded by start-of-text
    // or whitespace. Stop on whitespace/newline before finding one — no
    // mention in progress then.
    let i = cursor - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        const prev = i > 0 ? value[i - 1] : '';
        if (i === 0 || /\s/.test(prev)) {
          const query = value.slice(i + 1, cursor);
          // Reject if the partial contains whitespace (commit boundary).
          if (/\s/.test(query)) return null;
          return { start: i, end: cursor, query };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i -= 1;
    }
    return null;
  }

  // True while the IME is composing (Korean/Japanese/Chinese). We
  // suppress mention updates during composition because aliases are
  // strict ASCII — any preedit char in the query is noise — and because
  // committing composition fires a synthetic Enter that would otherwise
  // race the popup's keydown handler.
  const composingRef = useRef(false);

  function updateMentionFromTextarea() {
    if (mentionWorkers.length === 0) {
      if (mention) setMention(null);
      return;
    }
    if (composingRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    // A range selection is a deliberate user gesture (selecting text to
    // overtype etc.) — don't pop up a mention picker over it.
    if (
      typeof el.selectionEnd === 'number' &&
      el.selectionEnd !== el.selectionStart
    ) {
      if (mention) setMention(null);
      return;
    }
    const cursor = el.selectionStart ?? input.length;
    const next = detectMentionAtCursor(input, cursor);
    if (!next) {
      if (mention) setMention(null);
      return;
    }
    if (
      !mention ||
      next.start !== mention.start ||
      next.end !== mention.end ||
      next.query !== mention.query
    ) {
      setMention(next);
      setMentionIndex(0);
    }
  }

  function pickMention(worker: MentionWorker) {
    if (!mention) return;
    const before = input.slice(0, mention.start);
    const after = input.slice(mention.end);
    const inserted = `@${worker.member.alias} `;
    const next = before + inserted + after;
    setInput(next);
    setMention(null);
    // Restore cursor right after the inserted alias.
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }
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

  // Reset transient/derived state on session switch. The actual data
  // (messages / queue / runStatus) now arrives via the SWR hooks below —
  // those return cached data synchronously when the session was visited
  // before, so the tab switch feels instant instead of waiting on three
  // serial HTTP round trips. We still clear the local mirrors here so a
  // cold-cache switch doesn't briefly show the previous session's data
  // before SWR's fetcher resolves.
  // Full reset on session switch. Locally-edited fields like model /
  // effort only re-pull from the session prop here, never on incidental
  // prop changes (a nextImageNumber bump from sending an image used to
  // clobber a just-saved pick).
  useEffect(() => {
    setMessages([]);
    setQueue([]);
    setRunKind(null);
    setShellRunning(false);
    setError(null);
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
    nextAttachmentNumberRef.current = session.nextImageNumber;
    setModel(session.model);
    setEffort(session.reasoningEffort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Keep the attachment-counter ref in sync without re-running the
  // session reset above.
  useEffect(() => {
    nextAttachmentNumberRef.current = session.nextImageNumber;
  }, [session.nextImageNumber]);

  // SWR caches per-session payloads so tab switches render from cache
  // instantly. WS handlers keep `messages`/`queue` live during a streaming
  // turn — SWR's role here is the "snap-to-fresh" safety net on focus and
  // network reconnect, not a per-event mirror.
  const { data: messagesData, error: messagesError, mutate: mutateMessages } =
    useSWR(cacheKeys.sessionMessages(session.id), () =>
      api.listMessages(session.id),
    );
  const { data: queueData } = useSWR(cacheKeys.sessionQueue(session.id), () =>
    api.listQueue(session.id),
  );
  const { data: runStatusData } = useSWR(
    cacheKeys.runStatus(session.id),
    () => api.getRunStatus(session.id),
  );
  // "Refresh" re-fetches the conversation from the backend — recovers from a
  // dropped WebSocket / out-of-sync local copy without reloading the whole app.
  const refreshConversation = useCallback(() => {
    void mutateMessages();
  }, [mutateMessages]);

  // When SWR delivers a payload (initial or revalidate), replace the local
  // working copy. Mid-turn WS streams continue mutating from there.
  // Comparing identity is enough: SWR returns the same reference unless
  // the underlying fetch returned new data.
  useEffect(() => {
    if (messagesData) setMessages(messagesData);
  }, [messagesData]);
  useEffect(() => {
    if (queueData) setQueue(queueData);
  }, [queueData]);
  useEffect(() => {
    if (!runStatusData) return;
    setRunKind(runStatusData.ai ? 'ai' : null);
    setShellRunning(runStatusData.exec);
  }, [runStatusData]);
  useEffect(() => {
    if (messagesError) setError(String(messagesError));
  }, [messagesError]);

  // When the WS reconnects (e.g. tab woke up after browser throttling
  // killed the socket), pull fresh state for this session. SWR's focus
  // revalidate covers most cases, but a long backgrounded tab may have a
  // dead socket without losing focus, so the reconnect-specific signal
  // matters as a separate trigger.
  useWebSocket(
    `session:${session.id}`,
    (ev) => {
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
    },
    {
      onReconnect: () => {
        void mutateMessages();
      },
    },
  );

  // Virtuoso owns scroll mechanics now. We track atBottom via its
  // atBottomStateChange callback instead of an onScroll handler, and
  // call scrollToIndex through the imperative handle for the jump-to-
  // latest button. ResizeObserver / auto-scroll-on-message effects are
  // dropped — Virtuoso's `followOutput` keeps the latest item anchored
  // when at bottom, including across textarea growth and queue mounts.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // While the initial scroll-to-bottom is in flight Virtuoso first reports
  // atBottom=true (empty data) then atBottom=false (data populates, mounted
  // at top) and only after our scrollToIndex lands does it flip back to
  // true. Without a gate the jump-to-latest pill pops in for one frame on
  // every tab switch. Track our own "scroll has actually landed" signal
  // and only let the pill render once that has happened for this session.
  const didInitialScroll = useRef(false);
  const [initialScrollSettled, setInitialScrollSettled] = useState(false);
  const handleAtBottomChange = useCallback((next: boolean) => {
    setAtBottom(next);
    if (next) {
      setUnseenCount(0);
      // The first atBottom=true that arrives BEFORE we've kicked off
      // scrollToIndex is just Virtuoso reporting on the empty/partial
      // mount state — ignore it. Only the at-bottom that follows our own
      // scroll attempt counts as "settled".
      if (didInitialScroll.current) setInitialScrollSettled(true);
    }
  }, []);
  const followOutput = useCallback(
    (isAtBottom: boolean) => (isAtBottom ? ('smooth' as const) : false),
    [],
  );

  // `initialTopMostItemIndex` only captures the value at Virtuoso's first
  // render, which lands while messages are still being seeded from cache.
  // Once the first non-empty batch arrives for a session, jump to the tail
  // ourselves. The ref + settled flag reset on session switch so each tab
  // gets one landing scroll instead of fighting the user mid-conversation.
  useEffect(() => {
    didInitialScroll.current = false;
    setInitialScrollSettled(false);
  }, [session.id]);
  useEffect(() => {
    if (didInitialScroll.current) return;
    if (renderItems.length === 0) return;
    didInitialScroll.current = true;
    // Defer to after the list has measured its rows; otherwise Virtuoso
    // scrolls to an estimated position and stops short of the real bottom.
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: renderItems.length - 1,
        align: 'end',
      });
    });
  }, [renderItems.length]);

  // Re-align to bottom on any list height change (markdown commit,
  // image load, footer reflow) when the user was already at bottom.
  // followOutput alone aligns to *estimated* heights and falls short.
  const atBottomRef = useRef(atBottom);
  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);
  const renderItemsCountRef = useRef(renderItems.length);
  useEffect(() => {
    renderItemsCountRef.current = renderItems.length;
  }, [renderItems.length]);
  const handleTotalListHeightChanged = useCallback(() => {
    if (!atBottomRef.current) return;
    const count = renderItemsCountRef.current;
    if (count === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: count - 1,
      align: 'end',
      behavior: 'auto',
    });
  }, []);

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
            .map((a) => imageToPayload(a.file, a.mimeType)),
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

  async function changeModel(next: string | null) {
    setModel(next);
    try {
      const updated = await api.updateSession(session.id, { model: next });
      onSessionUpdate?.(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function changeEffort(next: Session['reasoningEffort']) {
    setEffort(next);
    try {
      const updated = await api.updateSession(session.id, {
        reasoningEffort: next,
      });
      onSessionUpdate?.(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  // useCallback so MessageBubble (now memoized below) doesn't re-render
  // every row on every parent render just because togglePin gets a new
  // identity. setMessages takes a functional updater so we don't need
  // messages in the deps.
  const togglePin = useCallback(
    async (message: Message) => {
      try {
        const updated = await api.updateMessage(message.id, { pinned: !message.pinned });
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        onPinChange(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onPinChange],
  );

  function scrollToBottom() {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'smooth',
    });
    setUnseenCount(0);
    setAtBottom(true);
  }

  return (
    <div
      className="flex flex-col min-h-0 bg-[var(--color-surface)] h-full"
      style={{ '--chat-font-size': `${chatFontSize}px` } as CSSProperties}
    >
      <div className="group/chrome flex-1 min-h-0 relative flex flex-col">
        {/* Per-session chat zoom + refresh — appears on hover (or keyboard
            focus), top-right. Mirrors the terminal's control; zoom is
            independent of app/browser zoom so the conversation can be sized on
            its own. Named group so it doesn't entangle the message bubbles'
            own group-hover actions. */}
        <div className="absolute left-2 top-2 z-20 flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-200 group-hover/chrome:opacity-100 group-focus-within/chrome:opacity-100">
          <button
            type="button"
            onClick={() => changeChatFontSize(-1)}
            disabled={chatFontSize <= 11}
            title="Smaller text"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Minus size={12} />
          </button>
          <span className="w-6 text-center text-[10px] tabular-nums text-[var(--color-ink-muted)]">
            {chatFontSize}
          </span>
          <button
            type="button"
            onClick={() => changeChatFontSize(1)}
            disabled={chatFontSize >= 24}
            title="Larger text"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Plus size={12} />
          </button>
          <span className="mx-0.5 h-3.5 w-px bg-[var(--color-border)]" aria-hidden />
          <button
            type="button"
            onClick={refreshConversation}
            disabled={aiRunning || streamingIds.size > 0}
            title={
              aiRunning || streamingIds.size > 0
                ? 'Refresh disabled while the agent is replying'
                : 'Refresh conversation'
            }
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-ink-muted)]"
          >
            <RotateCw size={12} />
          </button>
        </div>
        <Virtuoso
          ref={virtuosoRef}
          className="flex-1 text-sm"
          data={renderItems}
          computeItemKey={(_, item) =>
            item.kind === 'tool-group' ? item.key : item.message.id
          }
          itemContent={(_, item) => (
            <div className="px-4 pb-3">
              {item.kind === 'tool-group' ? (
                <ToolGroup messages={item.messages} />
              ) : (
                <MessageBubble
                  message={item.message}
                  sessionAgent={session.agent}
                  onTogglePin={togglePin}
                  streaming={streamingIds.has(item.message.id)}
                />
              )}
            </div>
          )}
          components={{
            Header: () => <div className="h-4" aria-hidden />,
            Footer: () => (
              <div className="px-4 pb-4 space-y-3">
                {aiRunning && streamingIds.size === 0 && (
                  <div className="text-xs text-[var(--color-ink-muted)] space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="italic">
                        {verb}…
                        {elapsedSec > 0 && (
                          <span className="not-italic opacity-70">
                            {' '}({formatElapsed(elapsedSec)})
                          </span>
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
            ),
            EmptyPlaceholder: () => (
              <div className="px-4 pt-4 text-[var(--color-ink-muted)]">
                Start the conversation. AI answers can be pinned so they stay visible.
              </div>
            ),
          }}
          followOutput={followOutput}
          atBottomStateChange={handleAtBottomChange}
          // Default 0 is too strict — 1-2px jitter from Footer reflow
          // flips atBottom to false and breaks followOutput's tracking.
          atBottomThreshold={60}
          totalListHeightChanged={handleTotalListHeightChanged}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          initialTopMostItemIndex={Math.max(0, renderItems.length - 1)}
        />

        {initialScrollSettled && !atBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border)] shadow-lg px-3 py-1.5 text-xs flex items-center gap-1.5 hover:border-[var(--color-accent)]"
          >
            <ArrowDown size={12} />
            {unseenCount > 0 ? (
              <span>{unseenCount} new</span>
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
                  // Single bulk DELETE: backend wipes the table for this
                  // session and fires one queue_updated broadcast instead
                  // of N parallel ones.
                  void api.clearQueue(session.id).catch(() => {});
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
                  onClick={async () => {
                    // Await removal first so the item never appears both in
                    // the queue and in the textarea — if the DELETE fails
                    // (network/404), keep the queue intact and surface the
                    // error rather than silently double-staging the text.
                    try {
                      await api.removeQueueItem(session.id, item.id);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                      return;
                    }
                    setInput(item.content);
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
          <Tooltip
            label={wikiSyncing ? 'Syncing to wiki…' : 'Sync this session to wiki'}
            side="top"
          >
            <button
              type="button"
              onClick={syncWiki}
              disabled={wikiSyncing}
              className="shrink-0 h-9 w-9 flex items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <BookPlus size={14} className={wikiSyncing ? 'animate-pulse' : ''} />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image (or paste from clipboard)"
            disabled={isShellMode || aiRunning}
            className="shrink-0 h-9 w-9 flex items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ImagePlus size={14} />
          </button>
          <div className="flex-1 relative">
            {mention && filteredMentions.length > 0 && (
              <MentionPopup
                workers={filteredMentions}
                highlightIndex={mentionIndex}
                onPick={pickMention}
                onHover={setMentionIndex}
              />
            )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Defer until after the value commits so cursor reads are
              // accurate (some browsers update selection lazily).
              queueMicrotask(updateMentionFromTextarea);
            }}
            onSelect={updateMentionFromTextarea}
            onCompositionStart={() => {
              composingRef.current = true;
              if (mention) setMention(null);
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              queueMicrotask(updateMentionFromTextarea);
            }}
            onBlur={() => {
              // Delay so a click on a popup row still fires.
              setTimeout(() => setMention(null), 100);
            }}
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
              // Mention popup keyboard navigation takes precedence so
              // Enter/Tab pick a worker instead of submitting the chat.
              if (mention && filteredMentions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) =>
                    Math.min(i + 1, filteredMentions.length - 1),
                  );
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  if (e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  pickMention(filteredMentions[mentionIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
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
            className={`block w-full resize-none rounded border px-3 py-[7px] text-sm leading-5 ${
              isShellMode
                ? 'bg-[var(--color-tool-bg)] border-[var(--color-tool-border)] font-mono text-[var(--color-tool-ink)]'
                : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'
            }`}
          />
          </div>
          <button
            type="submit"
            disabled={(!input.trim() && attachments.length === 0) || uploadingAttachments}
            className={`shrink-0 h-9 rounded px-3 text-sm disabled:opacity-40 font-medium flex items-center justify-center gap-1.5 ${
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
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-2">
                    <span>Model</span>
                    <ModelPicker
                      value={model}
                      onChange={changeModel}
                      agent={session.agent}
                      side="top"
                      disabled={aiRunning}
                    />
                  </span>
                  <span className="flex items-center gap-2">
                    <span>Effort</span>
                    <EffortPicker
                      value={effort}
                      onChange={changeEffort}
                      agent={session.agent}
                      side="top"
                      disabled={aiRunning}
                    />
                  </span>
                </div>
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

// Renamed inner component so we can wrap with React.memo at the bottom
// without changing the call site. Without memoization every stream_chunk
// (~10/sec while a turn is streaming) re-renders all N rows; on a 2800-
// message session that was the main source of frame drops.
function MessageBubbleInner({
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
  // Show the action toolbar (copy / raw toggle / download / pin) only for
  // user+assistant once streaming is done. Mid-stream toggling to rendered
  // markdown re-parses on every chunk, and tool/system rows render via
  // ToolMessage / plain text where the actions don't carry the same meaning.
  const showActions = canPin;
  // Assistant turns default to rendered markdown once they settle; user
  // messages default to raw so what you typed is shown verbatim (no stray
  // markdown reflow). Streaming always forces raw since re-parsing on every
  // chunk drops frames. The toggle is a per-bubble override either way.
  const [rawView, setRawView] = useState(message.role === 'user');
  const renderAsMarkdown = !streaming && !rawView;

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
          {showActions && (
            <div className="flex items-center gap-0.5">
              <RawViewToggle rawView={rawView} onChange={setRawView} />
              <CopyMarkdownButton content={message.content} />
              <DownloadMarkdownButton
                content={message.content}
                filenameHint={`${message.role}-${message.id.slice(0, 8)}`}
              />
            </div>
          )}
          {canPin && (
            <PinToggleButton
              pinned={message.pinned}
              onClick={() => onTogglePin(message)}
            />
          )}
        </div>
      </div>
      <div className="px-3 py-2 min-w-0">
        {message.role === 'tool' ? (
          <ToolMessage message={message} />
        ) : renderAsMarkdown ? (
          <Markdown content={message.content} />
        ) : (
          <div
            className="whitespace-pre-wrap break-words"
            style={{ fontSize: 'var(--chat-font-size, 0.875rem)', lineHeight: 1.55 }}
          >
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

const MessageBubble = memo(MessageBubbleInner);
