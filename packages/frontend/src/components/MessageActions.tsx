import { useState, type ReactNode } from 'react';
import { Check, Code, Copy, Download, FileText, Pin } from 'lucide-react';
import { copyText, downloadMarkdown, slugify } from '../utils/download.js';

type Size = 'sm' | 'md';

function sizeProps(size: Size): { icon: number; pad: string } {
  return size === 'md'
    ? { icon: 14, pad: 'p-1 rounded hover:bg-[var(--color-surface-3)]' }
    : { icon: 14, pad: 'p-0.5' };
}

export function ActionIconButton({
  onClick,
  title,
  children,
  size = 'sm',
  tone = 'default',
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  size?: Size;
  tone?: 'default' | 'accent' | 'danger';
}) {
  const { pad } = sizeProps(size);
  const color =
    tone === 'accent'
      ? 'text-[var(--color-accent)] hover:text-red-400'
      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]';
  return (
    <button onClick={onClick} title={title} className={`${color} ${pad}`}>
      {children}
    </button>
  );
}

export function RawViewToggle({
  rawView,
  onChange,
  size = 'sm',
}: {
  rawView: boolean;
  onChange: (next: boolean) => void;
  size?: Size;
}) {
  const { icon } = sizeProps(size);
  return (
    <ActionIconButton
      onClick={() => onChange(!rawView)}
      title={rawView ? 'Show rendered markdown' : 'Show raw text'}
      size={size}
    >
      {rawView ? <FileText size={icon} /> : <Code size={icon} />}
    </ActionIconButton>
  );
}

export function CopyMarkdownButton({
  content,
  size = 'sm',
}: {
  content: string;
  size?: Size;
}) {
  const { icon } = sizeProps(size);
  const [copied, setCopied] = useState(false);
  async function copy() {
    await copyText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <ActionIconButton
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy as Markdown'}
      size={size}
    >
      {copied ? <Check size={icon} /> : <Copy size={icon} />}
    </ActionIconButton>
  );
}

export function DownloadMarkdownButton({
  content,
  filenameHint,
  size = 'sm',
}: {
  content: string;
  filenameHint: string;
  size?: Size;
}) {
  const { icon } = sizeProps(size);
  async function download() {
    const base = slugify(filenameHint, 'message');
    await downloadMarkdown(`${base}.md`, content);
  }
  return (
    <ActionIconButton onClick={download} title="Download as .md" size={size}>
      <Download size={icon} />
    </ActionIconButton>
  );
}

export function PinToggleButton({
  pinned,
  onClick,
  size = 'sm',
  hoverOnly = false,
}: {
  pinned: boolean;
  onClick: () => void;
  size?: Size;
  hoverOnly?: boolean;
}) {
  const { icon, pad } = sizeProps(size);
  const visibility =
    hoverOnly && !pinned ? 'opacity-0 group-hover:opacity-100 transition-opacity' : '';
  const color = pinned
    ? 'text-[var(--color-accent)] hover:text-red-400'
    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]';
  return (
    <button
      onClick={onClick}
      title={pinned ? 'Unpin' : 'Pin'}
      className={`${color} ${pad} ${visibility}`}
    >
      <Pin size={icon} fill={pinned ? 'currentColor' : 'none'} />
    </button>
  );
}
