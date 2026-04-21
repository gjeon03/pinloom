import { useState } from 'react';
import type { Message } from '@pinloom/shared';

interface ToolUsePayload {
  name?: string;
  input?: Record<string, unknown>;
}

function parseToolUse(raw: string | null): ToolUsePayload | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ToolUsePayload;
  } catch {
    return null;
  }
}

export function ToolMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const payload = parseToolUse(message.toolUse);

  if (!payload) {
    return <span className="whitespace-pre-wrap">{message.content}</span>;
  }

  const name = payload.name ?? 'tool';
  const input = payload.input ?? {};

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-[10px] uppercase tracking-wide opacity-70">{expanded ? '▾' : '▸'}</span>
        <span className="font-semibold">{name}</span>
        <span className="flex-1 truncate text-[var(--color-ink-muted)]">
          {summarize(name, input)}
        </span>
      </button>
      {expanded && <div className="mt-2">{renderDetail(name, input)}</div>}
    </div>
  );
}

function summarize(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return String(input.file_path);
  if (typeof input.pattern === 'string') return `/${input.pattern}/`;
  return `${name} call`;
}

function renderDetail(name: string, input: Record<string, unknown>) {
  if (name === 'Edit') return <EditDetail input={input} />;
  if (name === 'Write') return <WriteDetail input={input} />;
  if (name === 'Bash') return <BashDetail input={input} />;
  return (
    <pre className="rounded bg-black/30 p-2 text-[11px] overflow-auto">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function EditDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-[var(--color-accent)]">{filePath}</div>
      <pre className="rounded bg-red-500/10 border border-red-500/30 p-2 text-[11px] overflow-auto whitespace-pre-wrap">
        - {oldStr}
      </pre>
      <pre className="rounded bg-emerald-500/10 border border-emerald-500/30 p-2 text-[11px] overflow-auto whitespace-pre-wrap">
        + {newStr}
      </pre>
    </div>
  );
}

function WriteDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const content = typeof input.content === 'string' ? input.content : '';
  const preview = content.split('\n').slice(0, 40).join('\n');
  const truncated = content.split('\n').length > 40;
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-[var(--color-accent)]">{filePath}</div>
      <pre className="rounded bg-emerald-500/10 border border-emerald-500/30 p-2 text-[11px] overflow-auto whitespace-pre-wrap">
        {preview}
        {truncated && `\n… (${content.split('\n').length - 40} more lines)`}
      </pre>
    </div>
  );
}

function BashDetail({ input }: { input: Record<string, unknown> }) {
  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : '';
  return (
    <div className="space-y-1">
      {description && (
        <div className="text-[11px] text-[var(--color-ink-muted)]">{description}</div>
      )}
      <pre className="rounded bg-black/40 border border-[var(--color-border)] p-2 text-[11px] overflow-auto whitespace-pre-wrap">
        $ {command}
      </pre>
    </div>
  );
}
