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

import { writeFileSync, type readSync } from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { cleanChildEnv } from '../child-env.js';
import { selectTurnLines, type JsonlLine } from '../claude-jsonl/index.js';
import type { ImageInput } from '../runner-types.js';
import type { UserPrompt } from '../agents/message-stream.js';
import { buildClaudeLaunch } from './launch-spec.js';
import { submitToTui } from './tui-input.js';
import type { ClaudeSession, ClaudeSessionFactory, ClaudeSessionSpec } from './session.js';
import {
  discoverNewSessionFile,
  listSessionFiles,
  readCheckpoint,
  sessionFilePath,
  sessionIdOf,
} from './transcript.js';
import {
  createClaudeTranscriptTailState,
  readClaudeTranscriptDelta,
} from './transcript-tail.js';
import { getStopHookServer, shutdownStopHookServer } from './shared-server.js';

const CLAUDE_BIN = process.env.PINLOOM_CLAUDE_BIN ?? 'claude';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ClaudeTurnTranscriptReader {
  readTurnSettled(file: string): Promise<JsonlLine[]>;
  discardPending(file: string): void;
}

interface ClaudeTurnTranscriptReaderDependencies {
  readChunk?: typeof readSync;
  wait?: (ms: number) => Promise<void>;
  settleAttempts?: number;
  settleIntervalMs?: number;
}

export function createClaudeTurnTranscriptReader(
  checkpoint: {
    completeOffset: number;
    transcriptIdentity: string;
  } | null,
  dependencies: ClaudeTurnTranscriptReaderDependencies = {},
): ClaudeTurnTranscriptReader {
  const state = createClaudeTranscriptTailState(checkpoint?.completeOffset ?? 0, {
    readChunk: dependencies.readChunk,
    transcriptIdentity: checkpoint?.transcriptIdentity ?? null,
  });
  const wait = dependencies.wait ?? sleep;
  const settleAttempts = dependencies.settleAttempts ?? 25;
  const settleIntervalMs = dependencies.settleIntervalMs ?? 120;

  return {
    discardPending(file: string): void {
      readClaudeTranscriptDelta(file, state);
    },
    async readTurnSettled(file: string): Promise<JsonlLine[]> {
      let appended: JsonlLine[] = [];
      let turn: JsonlLine[] = [];
      let settled = false;

      for (let attempt = 0; attempt < settleAttempts; attempt++) {
        const delta = readClaudeTranscriptDelta(file, state);
        if (delta.reset) {
          appended = [];
          console.warn('[claude-pty] transcript replaced or truncated; restarting turn read');
        } else if (delta.lines.length > 0) {
          appended.push(...delta.lines);
        }

        turn = selectTurnLines(appended, new Set<string>());
        settled = turn.some(
          (line) =>
            line.type === 'assistant' &&
            Array.isArray(line.message?.content) &&
            (line.message.content as unknown[]).length > 0,
        );
        if (settled) break;
        await wait(settleIntervalMs);
      }

      if (!settled) {
        console.warn('[claude-pty] turn produced no assistant content after settle window');
      }
      if (process.env.PINLOOM_PTY_DEBUG) {
        console.error('[pty] turn settled: %d lines extracted', turn.length);
      }
      return turn;
    },
  };
}

// Strip ANSI/cursor escapes and reduce to lowercase letters so we can match TUI
// prompts whose words the terminal lays out with cursor-move codes instead of
// spaces (e.g. "trust[20Gthis[25Gfolder" -> "trustthisfolder").
function ansiToAlpha(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();
}

// Drop pinloom's own runtime vars (PORT etc.) — see services/child-env.ts.
const cleanEnv = cleanChildEnv;

function materializeImages(images: ImageInput[], dir: string, turn: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = img.mimeType.split('/')[1] ?? 'png';
    // Per-turn prefix so a later turn's images can't clobber an earlier turn's
    // files in the session-lifetime temp dir.
    const file = path.join(dir, `img-${turn}-${i}.${ext}`);
    writeFileSync(file, Buffer.from(img.base64, 'base64'));
    paths.push(file);
  }
  return paths;
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

      // Build the temp launch env (isolated Stop-hook settings + forwarder + mcp)
      // and base argv via the shared launch spec. The positional seed prompt is
      // appended below, after we materialize turn-1 images into the temp dir.
      const launch = buildClaudeLaunch(
        {
          systemPrompt: spec.systemPrompt,
          model: spec.model,
          reasoningEffort: spec.reasoningEffort,
          resume: spec.resume,
          mcpServers: spec.mcpServers,
        },
        server.url(),
      );
      const tmp = launch.tmpDir;

      const before = spec.resume ? new Set<string>() : listSessionFiles(spec.cwd, home);

      // Seed the first turn via the positional [prompt] arg — for BOTH fresh and
      // resumed sessions (`claude --resume <id> "prompt"` auto-runs the prompt on
      // the resumed session; verified). This avoids typing into a freshly-launched
      // TUI, which is unreliable. Materialize turn-1 images up front and reference
      // them by @path. A resumed session checkpoints the transcript's complete
      // byte tail before launch so the seeded turn reads only appended records.
      const seedImages = materializeImages(spec.initialPrompt.images, tmp, 0);
      const initialText =
        seedImages.length > 0
          ? `${spec.initialPrompt.text} ${seedImages.map((p) => `@${p}`).join(' ')}`
          : spec.initialPrompt.text;
      if (initialText && initialText.length > 0) launch.args.push(initialText);
      const resumedSessionFile = spec.resume
        ? sessionFilePath(spec.cwd, spec.resume, home)
        : null;
      let transcriptReader = resumedSessionFile
        ? createClaudeTurnTranscriptReader(readCheckpoint(resumedSessionFile))
        : null;

      // When a home override is set (tests), point the child at it too so it
      // writes transcripts where we read them. In production `home` is undefined
      // and the child inherits the real $HOME.
      const childEnv = cleanEnv();
      if (home) childEnv.HOME = home;

      const child = pty.spawn(bin, launch.args, {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd: spec.cwd,
        env: childEnv,
      });

      // Keep a small tail of TUI output for diagnostics; we don't parse it.
      // lastDataAt drives the "TUI settled" readiness wait below.
      let tail = '';
      let lastDataAt = Date.now();
      child.onData((d) => {
        tail = (tail + d).slice(-4096);
        lastDataAt = Date.now();
      });

      // Lazy transcript discovery: a fresh interactive `claude` writes its
      // session JSONL only AFTER the first prompt is submitted, not on launch —
      // so for a fresh session we submit first, then discover (see runTurn). A
      // resumed session already has a known transcript file.
      let sessionId: string | null = spec.resume ?? null;
      let sessionFile: string | null = resumedSessionFile;
      let disposeP: Promise<void> | null = null;
      // Turn 1's images (if any) used index 0 via the seed; injected turns start at 1.
      let turnSeq = spec.resume ? 0 : 1;
      // The first prompt was seeded as the positional arg (fresh or resumed) —
      // the first runTurn reads it back rather than injecting it. Only when there
      // IS seed text: an empty initial prompt isn't passed as a positional, so
      // claude would sit idle — fall through to the inject path instead.
      let firstTurnSeeded = !!initialText;
      // Whether the TUI has been waited-for-ready + trust-cleared at least once.
      let tuiPrepared = false;

      // A brand-new cwd triggers claude's "Do you trust this folder?" dialog,
      // which blocks startup and isn't covered by --dangerously-skip-permissions.
      // The user added this project to pinloom, so trusting it is implied —
      // accept the default ("Yes, I trust this folder") by sending Enter once.
      let trustAccepted = false;
      function maybeAcceptTrustDialog(): void {
        if (trustAccepted) return;
        const clean = ansiToAlpha(tail);
        if (clean.includes('trustthisfolder') || clean.includes('doyoutrustthefiles')) {
          trustAccepted = true;
          child.write('\r');
          lastDataAt = Date.now(); // expect a redraw; keep waiting for settle
          if (process.env.PINLOOM_PTY_DEBUG) console.error('[pty] accepted trust dialog');
        }
      }

      // Let the TUI finish drawing its prompt before we paste. We must NOT treat
      // the brief silence *before claude prints anything* as ready (that races
      // ahead of the trust dialog), so require: at least MIN_MS elapsed, some
      // output seen, and then QUIET_MS of calm. Dismisses the trust dialog en route.
      async function waitForTuiReady(signal: AbortSignal): Promise<void> {
        const QUIET_MS = 600;
        const MIN_MS = 1500;
        const CAP_MS = 15_000;
        const startedAt = Date.now();
        while (!signal.aborted) {
          maybeAcceptTrustDialog();
          const elapsed = Date.now() - startedAt;
          const sawOutput = tail.length > 0;
          const calm = Date.now() - lastDataAt >= QUIET_MS;
          if (elapsed >= MIN_MS && sawOutput && calm) break;
          if (elapsed >= CAP_MS) break;
          await sleep(100);
        }
        if (process.env.PINLOOM_PTY_DEBUG)
          console.error('[pty] tui ready (trustAccepted=%s)', trustAccepted);
      }

      // Poll briefly to catch + accept the trust dialog. Returns once the dialog
      // is accepted, or once the TUI has produced output and settled (no dialog —
      // e.g. a pre-trusted dir or a resumed session), or after a short cap.
      async function clearStartupDialogs(signal: AbortSignal): Promise<void> {
        const cap = Date.now() + 10_000;
        while (!signal.aborted && Date.now() < cap) {
          maybeAcceptTrustDialog();
          if (trustAccepted) return;
          // A resumed session is in an already-trusted cwd (no dialog); a fresh
          // session's turn having started (its transcript appeared) also means
          // the dialog is past. Either way, stop waiting.
          if (spec.resume || listSessionFiles(spec.cwd, home).size > before.size) return;
          // Fallback for a real TUI that settled without a recognizable signal.
          if (tail.length > 0 && Date.now() - lastDataAt > 800) return;
          await sleep(150);
        }
      }

      // The Stop hook can fire a beat before claude flushes the final assistant
      // message to the transcript file — poll briefly until the selected turn
      // actually carries assistant content before returning it.
      async function readTurnSettled(): Promise<JsonlLine[]> {
        if (!sessionFile) return [];
        transcriptReader ??= createClaudeTurnTranscriptReader(null);
        return transcriptReader.readTurnSettled(sessionFile);
      }

      async function discover(signal: AbortSignal): Promise<void> {
        try {
          sessionId = sessionIdOf(
            await discoverNewSessionFile(spec.cwd, before, {
              home,
              timeoutMs: 30_000,
              signal,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`${msg}\nlast TUI output:\n${tail.slice(-500)}`);
        }
        sessionFile = sessionFilePath(spec.cwd, sessionId, home);
        transcriptReader = createClaudeTurnTranscriptReader(null);
      }

      return {
        sessionId(): string | null {
          return sessionId;
        },

        async runTurn(prompt: UserPrompt, signal: AbortSignal): Promise<JsonlLine[]> {
          if (firstTurnSeeded) {
            // claude was launched with this prompt as its positional arg; once we
            // clear the trust dialog it auto-runs the turn. Don't inject — await
            // the Stop hook (the server buffers a hook that fires before we arm,
            // via firedAhead) and read the new lines back.
            firstTurnSeeded = false;
            await clearStartupDialogs(signal);
            tuiPrepared = true;
            // Fresh session writes a brand-new transcript → discover it. A resumed
            // session already has a known file (set at start).
            if (sessionFile === null) await discover(signal);
            if (process.env.PINLOOM_PTY_DEBUG)
              console.error('[pty] seeded turn sid=%s resume=%s', sessionId, !!spec.resume);
            await server.awaitStop(sessionId!, signal);
            return readTurnSettled();
          }

          const imagePaths = materializeImages(prompt.images, tmp, turnSeq++);
          const text =
            imagePaths.length > 0
              ? `${prompt.text} ${imagePaths.map((p) => `@${p}`).join(' ')}`
              : prompt.text;

          // First time we inject — either a fresh-but-unseeded launch or a
          // resumed session whose TUI just started — wait for the TUI to settle
          // and clear any trust dialog before typing. Later turns reuse the
          // already-settled TUI and skip this.
          if (!tuiPrepared) {
            await waitForTuiReady(signal);
            tuiPrepared = true;
          }

          if (sessionFile === null) {
            // Fresh-but-unseeded (shouldn't normally happen): submit first, then
            // discover + arm completion.
            await submitToTui(child, text);
            await discover(signal);
            await server.awaitStop(sessionId!, signal);
            return readTurnSettled();
          }

          // If the previous turn timed out before a late assistant flush, drain
          // that completed suffix before submitting the next prompt so it can
          // never be attributed to the new turn.
          transcriptReader?.discardPending(sessionFile);

          // Arm BEFORE injecting so a fast turn cannot beat us to the Stop hook.
          // The process-lifetime transcript reader already sits at the previous
          // complete boundary, so only this turn's appended bytes are consumed.
          const stopped = server.awaitStop(sessionId!, signal);
          await submitToTui(child, text);
          await stopped;
          return readTurnSettled();
        },

        dispose(): Promise<void> {
          // Memoize the in-flight teardown so a concurrent caller (abort listener
          // + events() finally both fire dispose) actually awaits completion
          // instead of returning before killGroup's grace period elapses.
          if (disposeP) return disposeP;
          disposeP = (async () => {
            if (sessionId) server.release(sessionId);
            await killGroup(child);
            launch.cleanup();
          })();
          return disposeP;
        },
      };
    },
  };
}

export const nodeClaudeSessionFactory: ClaudeSessionFactory =
  createNodeClaudeSessionFactory();

/** Close the shared Stop-hook server (backend shutdown). */
export async function shutdownClaudePty(): Promise<void> {
  await shutdownStopHookServer();
}
