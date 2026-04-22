import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Maximize2,
  Pin,
  Send,
  Split,
} from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import {
  copyText,
  downloadManyAsZip,
  downloadMarkdown,
  slugify,
} from '../utils/download.js';
import { Markdown } from './Markdown.js';

interface Props {
  pins: Message[];
  onChange: (message: Message) => void;
  sessionId?: string;
  projectName?: string;
  showPopOut?: boolean;
  onHandoff?: (newSession: Session) => void;
  onSendPin?: (pin: Message) => void;
}

function buildPinMarkdown(pin: Message): string {
  const heading = pin.pinTitle ?? '(untitled pin)';
  return `# ${heading}\n\n${pin.content}\n`;
}

function pinFilename(pin: Message, idx: number): string {
  const base = slugify(pin.pinTitle ?? `pin-${String(idx + 1).padStart(2, '0')}`);
  return `${base}.md`;
}

export function PinnedPanel({
  pins,
  onChange,
  sessionId,
  projectName,
  showPopOut = true,
  onHandoff,
  onSendPin,
}: Props) {
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [focusedPinId, setFocusedPinId] = useState<string | null>(null);

  const focusedPin = focusedPinId ? pins.find((p) => p.id === focusedPinId) : null;

  // Auto-exit focus if the pin disappears (unpinned elsewhere, session switch, etc.)
  useEffect(() => {
    if (focusedPinId && !pins.find((p) => p.id === focusedPinId)) {
      setFocusedPinId(null);
    }
  }, [pins, focusedPinId]);

  // Esc exits focus
  useEffect(() => {
    if (!focusedPinId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setFocusedPinId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedPinId]);

  async function downloadAll() {
    if (pins.length === 0) return;
    const files = pins.map((pin, i) => ({
      filename: pinFilename(pin, i),
      content: buildPinMarkdown(pin),
    }));
    const baseName = projectName ? slugify(projectName, 'pinloom') : 'pinloom-pins';
    const zipName = `${baseName}-${new Date().toISOString().slice(0, 10)}`;
    await downloadManyAsZip(files, zipName);
  }

  async function handoff() {
    if (!sessionId || pins.length === 0) return;
    setHandoffError(null);
    try {
      const created = await api.handoffSession(sessionId);
      onHandoff?.(created);
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : String(err));
    }
  }

  if (focusedPin) {
    return (
      <aside className="h-full w-full border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
        <header className="border-b border-[var(--color-border)] px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => setFocusedPinId(null)}
            title="Back to list (Esc)"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            Focused pin
          </span>
        </header>
        <FocusedPinView
          pin={focusedPin}
          onChange={onChange}
          onSend={onSendPin}
        />
      </aside>
    );
  }

  return (
    <aside className="h-full w-full border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col min-h-0">
      <header className="border-b border-[var(--color-border)] px-4 py-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
          Pinned ({pins.length})
        </span>
        <div className="flex items-center gap-1">
          {onHandoff && pins.length > 0 && sessionId && (
            <button
              onClick={handoff}
              title="Start a new chat seeded with these pins"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
            >
              <Split size={14} />
            </button>
          )}
          {pins.length > 0 && (
            <button
              onClick={downloadAll}
              title="Download all pins as ZIP"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
            >
              <Download size={14} />
            </button>
          )}
          {showPopOut && sessionId && (
            <a
              href={`/pins/${sessionId}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open pins in new tab"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </header>
      {handoffError && (
        <p className="text-xs text-red-400 px-4 py-1.5 border-b border-[var(--color-border)]">
          {handoffError}
        </p>
      )}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {pins.map((pin) => (
          <PinCard
            key={pin.id}
            pin={pin}
            onChange={onChange}
            onSend={onSendPin}
            onFocus={() => setFocusedPinId(pin.id)}
          />
        ))}
      </div>
    </aside>
  );
}

function PinCard({
  pin,
  onChange,
  onSend,
  onFocus,
}: {
  pin: Message;
  onChange: (m: Message) => void;
  onSend?: (pin: Message) => void;
  onFocus: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pin.pinTitle ?? '');
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rawView, setRawView] = useState(false);

  async function saveTitle() {
    const next = title.trim() || null;
    const updated = await api.updateMessage(pin.id, { pinTitle: next });
    onChange(updated);
    setEditing(false);
  }

  async function unpin() {
    const updated = await api.updateMessage(pin.id, { pinned: false });
    onChange(updated);
  }

  async function copy() {
    await copyText(buildPinMarkdown(pin));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function download() {
    const base = slugify(pin.pinTitle ?? `pin-${pin.id.slice(0, 8)}`);
    await downloadMarkdown(`${base}.md`, buildPinMarkdown(pin));
  }

  return (
    <article className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] overflow-auto max-h-96">
      <header className="flex items-center gap-2 px-3 py-2 sticky top-0 z-10 bg-[var(--color-surface)]/95 backdrop-blur-sm border-b border-[var(--color-border)]/60">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] p-0.5"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') {
                setTitle(pin.pinTitle ?? '');
                setEditing(false);
              }
            }}
            className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-2 py-0.5 text-sm"
          />
        ) : (
          <button
            onClick={() => {
              setTitle(pin.pinTitle ?? '');
              setEditing(true);
            }}
            className="flex-1 truncate text-left text-sm font-medium hover:text-[var(--color-accent)]"
            title="Click to edit title"
          >
            {pin.pinTitle ?? '(untitled pin)'}
          </button>
        )}
        <button
          onClick={onFocus}
          title="Expand this pin"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-0.5"
        >
          <Maximize2 size={14} />
        </button>
        <button
          onClick={() => setRawView((v) => !v)}
          title={rawView ? 'Show rendered markdown' : 'Show raw text'}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-0.5"
        >
          {rawView ? <FileText size={14} /> : <Code size={14} />}
        </button>
        <button
          onClick={copy}
          title={copied ? 'Copied!' : 'Copy as Markdown'}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-0.5"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          onClick={download}
          title="Download as .md"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-0.5"
        >
          <Download size={14} />
        </button>
        {onSend && (
          <button
            onClick={() => onSend(pin)}
            title="Send this pin to another session"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-0.5"
          >
            <Send size={14} />
          </button>
        )}
        <button
          onClick={unpin}
          title="Unpin"
          className="text-[var(--color-accent)] hover:text-red-400 p-0.5"
        >
          <Pin size={14} fill="currentColor" />
        </button>
      </header>
      {!collapsed && (
        <div className="px-3 py-2 text-[var(--color-ink)]/90">
          {rawView ? (
            <div className="whitespace-pre-wrap text-sm font-mono">{pin.content}</div>
          ) : (
            <Markdown content={pin.content} />
          )}
        </div>
      )}
    </article>
  );
}

function FocusedPinView({
  pin,
  onChange,
  onSend,
}: {
  pin: Message;
  onChange: (m: Message) => void;
  onSend?: (pin: Message) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pin.pinTitle ?? '');
  const [copied, setCopied] = useState(false);
  const [rawView, setRawView] = useState(false);

  useEffect(() => {
    setTitle(pin.pinTitle ?? '');
  }, [pin.pinTitle]);

  async function saveTitle() {
    const next = title.trim() || null;
    const updated = await api.updateMessage(pin.id, { pinTitle: next });
    onChange(updated);
    setEditing(false);
  }

  async function unpin() {
    const updated = await api.updateMessage(pin.id, { pinned: false });
    onChange(updated);
  }

  async function copy() {
    await copyText(buildPinMarkdown(pin));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function download() {
    const base = slugify(pin.pinTitle ?? `pin-${pin.id.slice(0, 8)}`);
    await downloadMarkdown(`${base}.md`, buildPinMarkdown(pin));
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-2">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') {
                setTitle(pin.pinTitle ?? '');
                setEditing(false);
              }
            }}
            className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-base"
          />
        ) : (
          <button
            onClick={() => {
              setTitle(pin.pinTitle ?? '');
              setEditing(true);
            }}
            className="flex-1 text-left text-base font-semibold truncate hover:text-[var(--color-accent)]"
            title="Click to edit title"
          >
            {pin.pinTitle ?? '(untitled pin)'}
          </button>
        )}
        <button
          onClick={() => setRawView((v) => !v)}
          title={rawView ? 'Show rendered markdown' : 'Show raw text'}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
        >
          {rawView ? <FileText size={14} /> : <Code size={14} />}
        </button>
        <button
          onClick={copy}
          title={copied ? 'Copied!' : 'Copy as Markdown'}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          onClick={download}
          title="Download as .md"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
        >
          <Download size={14} />
        </button>
        {onSend && (
          <button
            onClick={() => onSend(pin)}
            title="Send this pin to another session"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] p-1 rounded hover:bg-[var(--color-surface-3)]"
          >
            <Send size={14} />
          </button>
        )}
        <button
          onClick={unpin}
          title="Unpin"
          className="text-[var(--color-accent)] hover:text-red-400 p-1 rounded hover:bg-[var(--color-surface-3)]"
        >
          <Pin size={14} fill="currentColor" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 text-[var(--color-ink)]/90">
        {rawView ? (
          <pre className="whitespace-pre-wrap text-sm font-mono">{pin.content}</pre>
        ) : (
          <Markdown content={pin.content} />
        )}
      </div>
    </div>
  );
}
