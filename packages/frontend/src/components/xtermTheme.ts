import type { ITheme, Terminal as XTerm } from '@xterm/xterm';

// xterm palettes for the two app themes. A TUI/shell emits its own ANSI colors;
// we set the background/foreground/cursor/selection + a light-friendly base so a
// light app theme doesn't render the terminal on a dark slab (and bright-white
// text stays legible on a light background). Shared by every xterm surface
// (agent chat terminal + the project shell terminal) so they theme identically.
const DARK_XTERM: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
};
const LIGHT_XTERM: ITheme = {
  background: '#fbfbfc',
  foreground: '#26272e',
  cursor: '#26272e',
  cursorAccent: '#fbfbfc',
  selectionBackground: '#bcd5fb',
  // Pull the bright ramp down so a TUI using bold/bright white (common for
  // emphasis) stays readable on the light background.
  white: '#3b3d46',
  brightWhite: '#26272e',
};

export function currentXtermTheme(): ITheme {
  return document.documentElement.dataset.theme === 'light' ? LIGHT_XTERM : DARK_XTERM;
}

// Re-theme `term` live when the app flips light/dark (theme.ts toggles
// documentElement.dataset.theme). Returns a disconnect fn for effect cleanup.
export function watchXtermTheme(term: XTerm): () => void {
  const observer = new MutationObserver(() => {
    term.options.theme = currentXtermTheme();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}
