// Inject a prompt into a live claude TUI as keystrokes. Shared by the PTY
// adapter (node-session) and terminal-mode worker dispatch (agent-terminal).
// Injecting into a SETTLED TUI is reliable; injecting into a freshly-launched
// one is not — callers seed the first turn via the positional arg instead.

import type { IPty } from 'node-pty';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Millisecond pauses around the submit — the most version-fragile spot.
const TUI_SETTLE_BEFORE_ENTER_MS = 120;
const TUI_SETTLE_AFTER_ENTER_MS = 20;

/**
 * Type `text` into the TUI then press Enter. A multi-line prompt is wrapped in
 * bracketed paste so its newlines aren't treated as separate submissions; a
 * single line is typed plainly (some TUIs swallow the CR right after a paste-end).
 * Bracketed-paste markers in the payload are stripped so a prompt can't break out
 * of the paste and drive the TUI as keystrokes.
 */
export async function submitToTui(child: IPty, text: string): Promise<void> {
  const safe = text.replace(/\x1b\[20[01]~/g, '');
  if (safe.includes('\n')) {
    child.write('\x1b[200~' + safe + '\x1b[201~');
  } else {
    child.write(safe);
  }
  await sleep(TUI_SETTLE_BEFORE_ENTER_MS);
  child.write('\r');
  await sleep(TUI_SETTLE_AFTER_ENTER_MS);
}
