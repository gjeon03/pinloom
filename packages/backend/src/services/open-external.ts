import { spawn } from 'node:child_process';

/** Launch a file/folder in the OS default handler. macOS-only for now (`open`);
 *  other platforms get a clear error so the UI can fall back to a shown path.
 *  Shared by the wiki + timeline "open in editor" routes. */
export function openExternal(filePath: string): { ok: boolean; error?: string } {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: `Auto-open is only supported on macOS for now. Path: ${filePath}`,
    };
  }
  try {
    const child = spawn('open', [filePath], { stdio: 'ignore', detached: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
