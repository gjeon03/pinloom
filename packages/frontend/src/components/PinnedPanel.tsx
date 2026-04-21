import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Pin,
  Send,
  Split,
} from 'lucide-react';
import type { Message, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { copyText, downloadMarkdown, slugify } from '../utils/download.js';
import { Markdown } from './Markdown.js';

interface Props {
  pins: Message[];
  onChange: (message: Message) => void;
  sessionId?: string;
  showPopOut?: boolean;
  onHandoff?: (newSession: Session) => void;
  onSendPin?: (pin: Message) => void;
}

function buildBulkMarkdown(pins: Message[]): string {
  const lines: string[] = [
    `# pinloom pins`,
    `Exported ${new Date().toISOString()}`,
    '',
  ];
  for (const pin of pins) {
    lines.push('---', '');
    lines.push(`## ${pin.pinTitle ?? '(untitled pin)'}`, '');
    lines.push(pin.content, '');
  }
  return lines.join('\n');
}

export function PinnedPanel({
  pins,
  onChange,
  sessionId,
  showPopOut = true,
  onHandoff,
  onSendPin,
}: Props) {
  const [handoffError, setHandoffError] = useState<string | null>(null);

  function downloadAll() {
    if (pins.length === 0) return;
    const filename = `pinloom-pins-${new Date().toISOString().slice(0, 10)}.md`;
    downloadMarkdown(filename, buildBulkMarkdown(pins));
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
              title="Download all pins as Markdown"
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
          <PinCard key={pin.id} pin={pin} onChange={onChange} onSend={onSendPin} />
        ))}
      </div>
    </aside>
  );
}

function PinCard({
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

  function buildMarkdown(): string {
    const heading = pin.pinTitle ?? '(untitled pin)';
    return `# ${heading}\n\n${pin.content}\n`;
  }

  async function copy() {
    await copyText(buildMarkdown());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function download() {
    const base = slugify(pin.pinTitle ?? `pin-${pin.id.slice(0, 8)}`);
    downloadMarkdown(`${base}.md`, buildMarkdown());
  }

  return (
    <article className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <header className="flex items-center gap-2 mb-1">
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
        <div className="border-t border-[var(--color-border)] pt-2 mt-1 max-h-96 overflow-auto text-[var(--color-ink)]/90">
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
