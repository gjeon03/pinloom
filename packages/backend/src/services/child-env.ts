// Environment for spawned user shells + agent CLIs (PTYs). Copies the parent
// process env but DROPS pinloom's own server-runtime vars so they never leak
// into the user's tools.
//
// The classic symptom this fixes: pinloom's backend runs with PORT set (e.g.
// 4788 in the desktop app). A naive env copy passed that PORT to the shell, so
// `next dev` / `vite` / CRA — all of which honor $PORT — bound that port
// instead of their own default (Next's 3000). Stripping these makes a terminal
// spawned by pinloom behave like a plain terminal.
const STRIP = new Set([
  'PORT', // dev servers honor it → wrong port; the reported bug
  'PINLOOM_DB_PATH',
  'PINLOOM_SERVE_STATIC',
  'PINLOOM_STATIC_DIR',
  'PINLOOM_TEST_MODE',
]);

// A GUI-launched process inherits NO locale: the desktop app is started from
// Finder/launchd, not a login shell, so the backend runs with LANG and every
// LC_* unset — and every pty we spawn inherits that emptiness. macOS tools then
// fall back to the legacy system encoding (MacRoman) instead of UTF-8.
//
// The reported symptom: copying Korean out of the claude terminal pasted back as
// mojibake ("파드는" -> "Ìåå..."). Claude Code's copy action shells out to
// `pbcopy`, and `pbcopy` decodes its stdin using the locale — with none set it
// reads our UTF-8 bytes as MacRoman and puts the double-encoded text on the
// pasteboard. Verified: `printf '파드는' | env -u LANG -u LC_ALL -u LC_CTYPE
// pbcopy` reproduces the exact bytes; adding a UTF-8 locale fixes it. The same
// terminal works from Terminal.app only because a login shell sets LANG.
//
// Set it only when the parent really has nothing, so an explicit locale (a
// developer running `pnpm dev`, or a user who wants ko_KR) always wins.
function applyUtf8LocaleDefault(env: { [key: string]: string }): void {
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return;
  env.LANG = 'en_US.UTF-8';
}

export function cleanChildEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !STRIP.has(k)) env[k] = v;
  }
  applyUtf8LocaleDefault(env);
  return env;
}
