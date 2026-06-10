// PTY-driven Claude adapter. Drives an interactive `claude` REPL via keystroke
// injection so its usage bills against the *interactive* (weekly) bucket rather
// than the separate $200/mo Agent-SDK credit bucket introduced 2026-06-15.
// See docs/billing/dual-bucket-plan.md.
//
// This file is pure orchestration: it owns the multi-turn loop, mid-run message
// injection, abort/close lifecycle, and maps each turn's transcript lines to the
// shared NormalizedEvent stream — identical to what the SDK/Codex adapters
// produce, so runner.ts consumes it unchanged. All the fragile, real-world bits
// (spawning the pty, the Stop-hook server, reading ~/.claude transcripts) live
// behind a ClaudeSessionFactory so this logic is unit-tested against a mock.
//
// NOTE: intentionally NOT registered in agents/index.ts yet. Wiring it as a
// selectable transport is the post-6/15 step, gated on the bucket experiments
// (gate 2/3). Until then it ships as a tested, dormant module — zero regression
// risk to the live SDK path.

import { toNormalizedEvents } from '../claude-jsonl/index.js';
import { UserPromptStream, type UserPrompt } from '../agents/message-stream.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
} from '../agents/types.js';
import type { ClaudeSession, ClaudeSessionFactory } from './session.js';

export function createClaudePtyAdapter(factory: ClaudeSessionFactory): AgentAdapter {
  return {
    // Transport detail — to the runner this is still "claude". A distinct
    // AgentKind isn't introduced until the feature is wired live.
    name: 'claude',

    run(args: AgentRunArgs): AgentRun {
      const promptStream = new UserPromptStream();
      promptStream.push(args.initialPrompt);

      let session: ClaudeSession | null = null;
      let aborted = false;

      args.abortController.signal.addEventListener('abort', () => {
        aborted = true;
        promptStream.close();
        // Best-effort: kill the REPL now; the events() finally also disposes.
        void session?.dispose().catch(() => {});
      });

      let sessionIdEmitted = false;

      async function* events(): AsyncGenerator<NormalizedEvent> {
        try {
          while (!aborted) {
            const prompt = await promptStream.next();
            if (prompt === null) return;

            if (!session) {
              session = await factory.start({
                cwd: args.cwd,
                // TUI claude has no prompt-cache split; concatenate both halves.
                systemPrompt: args.systemPrompt + (args.systemPromptDynamic ?? ''),
                initialPrompt: args.initialPrompt,
                model: args.model,
                resume: args.resume ?? null,
                reasoningEffort: args.reasoningEffort,
                mcpServers: args.mcpServers,
              });
            }

            let turnLines;
            try {
              turnLines = await session.runTurn(prompt, args.abortController.signal);
            } catch (err) {
              // abort/close make awaitStop reject — that's an expected, clean
              // end of the run (matches the SDK/Codex adapters' break-on-abort),
              // not a failure to propagate. A genuine error still surfaces.
              if (aborted) return;
              throw err;
            }
            if (aborted) return;

            // The session id is only known after the first turn for a fresh
            // session (the transcript is created on first submit), so emit it
            // lazily the moment it becomes available, exactly once.
            if (!sessionIdEmitted) {
              const sid = session.sessionId();
              if (sid) {
                yield { type: 'session_id', id: sid };
                sessionIdEmitted = true;
              }
            }

            for (const ev of toNormalizedEvents(turnLines, { sessionId: null })) {
              yield ev;
            }
          }
        } finally {
          await session?.dispose().catch(() => {});
        }
      }

      return {
        events: events(),
        pushMessage(prompt: UserPrompt) {
          promptStream.push(prompt);
        },
        close() {
          // Drain-then-dispose: closing the stream makes next() resolve null,
          // the loop returns, and the finally disposes the session.
          promptStream.close();
        },
      };
    },
  };
}
