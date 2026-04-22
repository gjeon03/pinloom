import JSZip from 'jszip';

export function slugify(input: string, fallback = 'pin'): string {
  const base = input
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '') // invalid filename chars + control
    .replace(/[\u200b-\u200f\ufeff]/g, '') // zero-width
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return base.length > 0 ? base.slice(0, 80) : fallback;
}

function anchorDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface FileSystemWritableFileStream {
  write: (data: Blob | string) => Promise<void>;
  close: () => Promise<void>;
}
interface FileSystemFileHandle {
  createWritable: () => Promise<FileSystemWritableFileStream>;
}
type ShowSave = (opts?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function getShowSaveFilePicker(): ShowSave | null {
  const w = window as unknown as { showSaveFilePicker?: ShowSave };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export async function downloadMarkdown(filename: string, content: string): Promise<void> {
  const suggestedName = filename.endsWith('.md') ? filename : `${filename}.md`;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const picker = getShowSaveFilePicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: 'Markdown file',
            accept: { 'text/markdown': ['.md'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (isAbortError(err)) return;
      // fall through to anchor download
    }
  }
  anchorDownload(suggestedName, blob);
}

export async function downloadManyAsZip(
  files: { filename: string; content: string }[],
  zipName: string,
): Promise<void> {
  if (files.length === 0) return;
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    const name = ensureUnique(used, f.filename.endsWith('.md') ? f.filename : `${f.filename}.md`);
    zip.file(name, f.content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const suggestedName = zipName.endsWith('.zip') ? zipName : `${zipName}.zip`;
  const picker = getShowSaveFilePicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: 'ZIP archive',
            accept: { 'application/zip': ['.zip'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (isAbortError(err)) return;
      // fall through to anchor download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ensureUnique(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (used.has(`${base}-${i}${ext}`)) i += 1;
  const next = `${base}-${i}${ext}`;
  used.add(next);
  return next;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
