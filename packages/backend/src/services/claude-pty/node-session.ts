// Real ClaudeSessionFactory: drives an actual interactive `claude` REPL through
// node-pty, isolates a Stop hook into a temp --settings file (NEVER touches the
// user's global ~/.claude/settings.json — that's a dotfiles symlink), and reads
// turns back from the session transcript.
//
// This is the version-sensitive, empirically-tuned layer. Its control flow is
// already CI-tested via the mock in claude-pty-adapter.test.ts; what only real
// `claude` can confirm (exact submit keystrokes, transcript slug, that the Stop
// hook fires every turn, and — post-6/15 — which billing bucket it lands in) is
// covered by scripts/billing-gates/integration-real-claude.mjs, which the user
// runs in a real terminal. See docs/billing/dual-bucket-plan.md.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { extractTurnLines, type JsonlLine } from '../claude-jsonl/index.js';
import type { ImageInput } from '../runner-types.js';
import type { UserPrompt } from '../agents/message-stream.js';
import type { ClaudeSession, ClaudeSessionFactory, ClaudeSessionSpec } from './session.js';
import {
  discoverNewSessionFile,
  listSessionFiles,
  readCheckpoint,
  readLines,
  sessionFilePath,
  sessionIdOf,
} from './transcript.js';
import { startStopHookServer, type StopHookServer } from './stop-hook-server.js';

const CLAUDE_BIN = process.env.PINLOOM_CLAUDE_BIN ?? 'claude';

// One shared Stop-hook server for the whole backend; sessions key on session_id.
let sharedServer: Promise<StopHookServer> | null = null;
function getStopHookServer(): Promise<StopHookServer> {
  return (sharedServer ??= startStopHookServer());
}

// ESM forwarder claude's Stop hook executes: reads the hook JSON on stdin and
// POSTs it to our localhost server. `fetch` is a Node global (>=18). Written
// fresh into each session's temp dir so there's no install/path resolution.
const FORWARDER_SRC = `let d='';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', async () => {
  try { await fetch(process.argv[2], { method: 'POST', body: d || '{}' }); } catch {}
  process.exit(0);
});
`;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

function materializeImages(images: ImageInput[], dir: string): string[] {
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = img.mimeType.split('/')[1] ?? 'png';
    const file = path.join(dir, `img-${i}.${ext}`);
    writeFileSync(file, Buffer.from(img.base64, 'base64'));
    paths.push(file);
  }
  return paths;
}

// Submit a prompt to the live TUI. Bracketed paste keeps a multi-line prompt
// from being interpreted as separate submissions; the trailing CR sends it.
// (Exact sequence is the most likely thing to need tuning against a new claude
// version — that's what the integration test guards.)
function submitToTui(child: IPty, text: string): void {
  child.write('\x1b[200~' + text + '\x1b[201~');
  child.write('\r');
}

function buildArgs(spec: ClaudeSessionSpec, settingsPath: string, mcpPath: string | null): string[] {
  const args: string[] = [
    // Isolate OUR Stop hook here; keep the user's own config loading too.
    '--settings',
    settingsPath,
    '--setting-sources',
    'user,project',
    // Non-interactive automation: no permission prompts.
    '--dangerously-skip-permissions',
  ];
  if (spec.systemPrompt.length > 0) {
    args.push('--append-system-prompt', spec.systemPrompt);
  }
  if (spec.model) args.push('--model', spec.model);
  if (mcpPath) args.push('--mcp-config', mcpPath);
  if (spec.resume) args.push('--resume', spec.resume);
  return args;
}

async function killGroup(child: IPty): Promise<void> {
  try {
    child.kill('SIGHUP');
  } catch {
    // already gone
  }
  await new Promise((r) => setTimeout(r, 300));
  try {
    // node-pty setsid's the child, so -pid targets the whole group.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {
      // gone
    }
  }
}

export interface NodeClaudeSessionOptions {
  /** Override the `claude` binary (tests point this at a mock executable). */
  claudeBin?: string;
  /** Override $HOME for transcript discovery (tests use a temp dir). */
  home?: string;
}

export function createNodeClaudeSessionFactory(
  options: NodeClaudeSessionOptions = {},
): ClaudeSessionFactory {
  const bin = options.claudeBin ?? CLAUDE_BIN;
  const home = options.home;

  return {
    async start(spec: ClaudeSessionSpec): Promise<ClaudeSession> {
      const server = await getStopHookServer();

    const tmp = mkdtempSync(path.join(tmpdir(), 'pinloom-claude-pty-'));
    const forwarderPath = path.join(tmp, 'stop-forward.mjs');
    writeFileSync(forwarderPath, FORWARDER_SRC, 'utf8');

    const settingsPath = path.join(tmp, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node ${JSON.stringify(forwarderPath)} ${JSON.stringify(server.url())}`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    let mcpPath: string | null = null;
    if (spec.mcpServers && Object.keys(spec.mcpServers).length > 0) {
      mcpPath = path.join(tmp, 'mcp.json');
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: spec.mcpServers }, null, 2), 'utf8');
    }

    const before = spec.resume ? new Set<string>() : listSessionFiles(spec.cwd, home);

    // When a home override is set (tests), point the child at it too so it
    // writes transcripts where we read them. In production `home` is undefined
    // and the child inherits the real $HOME.
    const childEnv = cleanEnv();
    if (home) childEnv.HOME = home;

    const child = pty.spawn(bin, buildArgs(spec, settingsPath, mcpPath), {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: spec.cwd,
      env: childEnv,
    });

    // Keep a small tail of TUI output for diagnostics; we don't parse it.
    let tail = '';
    child.onData((d) => {
      tail = (tail + d).slice(-4096);
    });

    let sessionId: string;
    try {
      sessionId = spec.resume
        ? spec.resume
        : sessionIdOf(await discoverNewSessionFile(spec.cwd, before, { home }));
    } catch (err) {
      await killGroup(child);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}\nlast TUI output:\n${tail.slice(-500)}`);
    }

    const sessionFile = sessionFilePath(spec.cwd, sessionId, home);
    let disposed = false;

    return {
      sessionId(): string {
        return sessionId;
      },

      async runTurn(prompt: UserPrompt, signal: AbortSignal): Promise<JsonlLine[]> {
        const checkpoint = readCheckpoint(sessionFile);

        // Arm the completion waiter BEFORE injecting so a fast turn can't fire
        // the Stop hook before we're listening.
        const stopped = server.awaitStop(sessionId, signal);

        const imagePaths = materializeImages(prompt.images, tmp);
        const text =
          imagePaths.length > 0
            ? `${prompt.text} ${imagePaths.map((p) => `@${p}`).join(' ')}`
            : prompt.text;
        submitToTui(child, text);

        await stopped;

        return extractTurnLines(readLines(sessionFile), checkpoint);
      },

      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await killGroup(child);
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      },
    };
    },
  };
}

export const nodeClaudeSessionFactory: ClaudeSessionFactory =
  createNodeClaudeSessionFactory();

/** Close the shared Stop-hook server (backend shutdown). */
export async function shutdownClaudePty(): Promise<void> {
  if (!sharedServer) return;
  const s = await sharedServer;
  sharedServer = null;
  await s.close();
}
