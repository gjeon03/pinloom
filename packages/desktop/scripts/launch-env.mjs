const CLAUDE_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_EFFORT',
];

// The deployment runner's terminal is not the app's terminal. In particular,
// automation's NO_COLOR=1 would disable color in every subsequently spawned PTY.
const TERMINAL_VARS = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'TERM', 'COLORTERM'];

export function createDesktopLaunchEnv(source = process.env) {
  const env = { ...source };
  for (const key of [...CLAUDE_MARKERS, ...TERMINAL_VARS]) delete env[key];
  return env;
}
