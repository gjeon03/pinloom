import { spawn } from 'node:child_process';

/** Launch a path via macOS `open`. With `{ reveal: true }` it adds `-R`, which
 *  opens the file's CONTAINING FOLDER in Finder with the file selected — instead
 *  of launching whatever app is bound to the file type (which for `.md` can be a
 *  terminal like Warp, useless for "show me where this lives"). Plain mode opens
 *  in the default handler. Other platforms return a clear error for the UI. */
export function openExternal(
  filePath: string,
  opts: { reveal?: boolean } = {},
): { ok: boolean; error?: string } {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: `Auto-open is only supported on macOS for now. Path: ${filePath}`,
    };
  }
  try {
    const args = opts.reveal ? ['-R', filePath] : [filePath];
    const child = spawn('open', args, { stdio: 'ignore', detached: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
