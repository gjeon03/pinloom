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

export function cleanChildEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !STRIP.has(k)) env[k] = v;
  }
  return env;
}
