import type { Terminal as XTerm } from '@xterm/xterm';

// Force xterm's copy to go through the ClipboardEvent API with an explicit
// Unicode string. In the Electron app the default selection→native-clipboard
// path writes the raw UTF-8 bytes under a legacy (MacRoman) pasteboard flavor,
// so pasted Korean/CJK comes out mojibake ("모" → "Î™®" — UTF-8 bytes read as
// MacRoman). Taking over the `copy` event and setting text/plain from
// term.getSelection() makes Chromium serialize the selection as proper Unicode,
// which fixes the paste on both web and app. No-op when nothing is selected.
export function installUnicodeCopy(el: HTMLElement, term: XTerm): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const sel = term.getSelection();
    if (!sel || !e.clipboardData) return; // no xterm selection — leave default
    e.clipboardData.setData('text/plain', sel);
    e.preventDefault();
  };
  // Capture phase so this runs before xterm's own descendant handlers and wins.
  el.addEventListener('copy', onCopy, true);
  return () => el.removeEventListener('copy', onCopy, true);
}
