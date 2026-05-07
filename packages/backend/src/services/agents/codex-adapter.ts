// Spawns the local `codex` CLI in non-interactive `exec --json` mode and
// translates its JSONL event stream into the same NormalizedEvent shape
// the Claude adapter produces. The orchestrator (runner.ts) consumes
// either stream interchangeably.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
} from './types.js';

const CODEX_BIN = process.env.PINLOOM_CODEX_BIN ?? 'codex';

interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}

interface CodexAgentMessage {
  type: 'agent_message';
  text: string;
}

interface CodexFileChange {
  type: 'file_change';
  changes: Array<{ path: string; kind: 'add' | 'update' | 'delete' | 'rename' }>;
  status?: 'in_progress' | 'completed';
}

interface CodexCommandExecution {
  type: 'command_execution';
  command: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: 'in_progress' | 'completed';
}

interface CodexReasoning {
  type: 'reasoning';
  text?: string;
}

interface CodexErrorItem {
  type: 'error';
  message?: string;
}

type CodexItem =
  | CodexAgentMessage
  | CodexFileChange
  | CodexCommandExecution
  | CodexReasoning
  | CodexErrorItem
  | { type: string; [k: string]: unknown };

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
}

function summarizeFileChange(item: CodexFileChange): {
  name: string;
  input: Record<string, unknown>;
  summary: string;
} {
  const first = item.changes[0];
  const verb =
    first?.kind === 'add'
      ? 'Write'
      : first?.kind === 'delete'
        ? 'Delete'
        : first?.kind === 'rename'
          ? 'Rename'
          : 'Edit';
  return {
    name: verb,
    input: { file_path: first?.path ?? '', changes: item.changes },
    summary: `${verb}: ${first?.path ?? '(unknown)'}${
      item.changes.length > 1 ? ` (+${item.changes.length - 1} more)` : ''
    }`,
  };
}

function summarizeCommand(item: CodexCommandExecution): {
  name: string;
  input: Record<string, unknown>;
  summary: string;
} {
  return {
    name: 'Bash',
    input: { command: item.command },
    summary: `Bash: ${item.command}`,
  };
}

class CodexAdapterImpl implements AgentAdapter {
  readonly name = 'codex' as const;

  run(args: AgentRunArgs): AgentRun {
    // Build argv. We use `--dangerously-bypass-approvals-and-sandbox` so
    // codex has the same effective capabilities as the Claude SDK runs in
    // pinloom (which uses `permissionMode: 'bypassPermissions'`). Without
    // this, codex's default workspace-write sandbox blocks ~/.gradle
    // writes, outbound network (e.g. distribution downloads), and local
    // TCP socket binds (Gradle daemon, dev servers, etc.) — Claude
    // sessions can do all of those, so the agent picker should be the
    // only meaningful difference. pinloom is local-only and single-user.
    const cliArgs: string[] = [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ];
    if (args.resume) {
      // Format: codex exec resume <SESSION_ID> [PROMPT] --json …
      // The prompt is appended via stdin so newlines/special chars survive.
      cliArgs.splice(1, 0, 'resume', args.resume);
    }
    if (args.model) cliArgs.push('--model', args.model);

    // Codex's --image flag takes file paths. Materialize each base64
    // attachment to a tempfile we'll clean up after the process ends.
    const tmpDir = args.images && args.images.length > 0
      ? mkdtempSync(path.join(tmpdir(), 'pinloom-codex-'))
      : null;
    const tmpFiles: string[] = [];
    if (tmpDir && args.images) {
      for (let i = 0; i < args.images.length; i++) {
        const img = args.images[i];
        const ext = img.mimeType.split('/')[1] ?? 'png';
        const file = path.join(tmpDir, `img-${i}.${ext}`);
        writeFileSync(file, Buffer.from(img.base64, 'base64'));
        tmpFiles.push(file);
        cliArgs.push('--image', file);
      }
    }

    // Compose stdin: [systemPrompt, then user prompt]. Codex doesn't have
    // a separate --system flag, so we prepend a "## System" block.
    const stdinPayload =
      args.systemPrompt.length > 0
        ? `${args.systemPrompt}\n\n---\n\n${args.prompt}`
        : args.prompt;

    // Final positional arg is "-" so the prompt is read from stdin.
    cliArgs.push('-');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(CODEX_BIN, cliArgs, {
        cwd: args.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Convert sync spawn error into a one-shot async stream so the caller
      // surfaces it through the same path it handles all other errors.
      const message = err instanceof Error ? err.message : String(err);
      const fallback = (async function* (): AsyncGenerator<NormalizedEvent> {
        throw new Error(
          `Failed to spawn '${CODEX_BIN}' (is the Codex CLI installed?). ${message}`,
        );
      })();
      return { events: fallback, close: () => {} };
    }

    let stdinClosed = false;
    try {
      child.stdin.write(stdinPayload);
      child.stdin.end();
      stdinClosed = true;
    } catch {
      // Best-effort — child may have already exited.
    }

    let killed = false;
    args.abortController.signal.addEventListener('abort', () => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    });

    const cleanup = () => {
      if (!stdinClosed) {
        try {
          child.stdin.end();
        } catch {
          // best-effort
        }
        stdinClosed = true;
      }
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    };

    let stderrBuffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
    });

    async function* lines(): AsyncGenerator<string> {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      for await (const chunk of child.stdout) {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) yield line;
          nl = buffer.indexOf('\n');
        }
      }
      if (buffer.trim().length > 0) yield buffer;
    }

    async function* events(): AsyncGenerator<NormalizedEvent> {
      try {
        for await (const line of lines()) {
          if (args.abortController.signal.aborted) break;
          let parsed: CodexEvent;
          try {
            parsed = JSON.parse(line) as CodexEvent;
          } catch {
            continue; // Skip malformed lines silently.
          }

          if (parsed.type === 'thread.started' && parsed.thread_id) {
            yield { type: 'session_id', id: parsed.thread_id };
            continue;
          }

          if (parsed.type === 'turn.completed') {
            yield { type: 'message_stop' };
            continue;
          }

          if (parsed.type === 'item.completed' || parsed.type === 'item.started') {
            const item = parsed.item;
            if (!item) continue;

            if (item.type === 'agent_message' && parsed.type === 'item.completed') {
              const msg = item as CodexAgentMessage;
              if (typeof msg.text === 'string' && msg.text.length > 0) {
                // Codex doesn't stream text — emit the whole block as a
                // single delta and immediately close it so the runner
                // persists one assistant row per agent_message.
                yield { type: 'text_delta', text: msg.text };
                yield { type: 'message_stop' };
              }
              continue;
            }

            if (
              item.type === 'reasoning' &&
              parsed.type === 'item.completed'
            ) {
              const r = item as CodexReasoning;
              if (typeof r.text === 'string' && r.text.length > 0) {
                yield { type: 'thinking_start' };
                yield { type: 'thinking_delta', text: r.text };
              }
              continue;
            }

            if (item.type === 'file_change' && parsed.type === 'item.started') {
              const tu = summarizeFileChange(item as CodexFileChange);
              yield {
                type: 'tool_use',
                name: tu.name,
                input: tu.input,
                summary: tu.summary,
              };
              continue;
            }

            if (item.type === 'file_change' && parsed.type === 'item.completed') {
              const fc = item as CodexFileChange;
              const status = fc.status === 'completed' ? 'applied' : (fc.status ?? 'done');
              yield {
                type: 'tool_result',
                text: `${status}: ${fc.changes.map((c) => `${c.kind} ${c.path}`).join(', ')}`,
                stream: 'stdout',
              };
              continue;
            }

            if (item.type === 'command_execution' && parsed.type === 'item.started') {
              const tu = summarizeCommand(item as CodexCommandExecution);
              yield {
                type: 'tool_use',
                name: tu.name,
                input: tu.input,
                summary: tu.summary,
              };
              continue;
            }

            if (item.type === 'command_execution' && parsed.type === 'item.completed') {
              const cmd = item as CodexCommandExecution;
              const text = cmd.aggregated_output ?? '';
              const isErr = typeof cmd.exit_code === 'number' && cmd.exit_code !== 0;
              if (text.length > 0) {
                yield {
                  type: 'tool_result',
                  text,
                  stream: isErr ? 'stderr' : 'stdout',
                };
              }
              continue;
            }

            if (item.type === 'error' && parsed.type === 'item.completed') {
              const err = item as CodexErrorItem;
              const msg = err.message ?? 'codex error';
              yield { type: 'tool_result', text: msg, stream: 'stderr' };
              continue;
            }
          }
        }

        const exitCode = await new Promise<number | null>((resolve) => {
          if (child.exitCode !== null) {
            resolve(child.exitCode);
          } else {
            child.once('close', (code) => resolve(code));
          }
        });

        if (!killed && exitCode !== 0 && exitCode !== null) {
          throw new Error(
            `codex exec exited with code ${exitCode}` +
              (stderrBuffer ? `: ${stderrBuffer.trim().slice(0, 500)}` : ''),
          );
        }
      } finally {
        cleanup();
      }
    }

    return {
      events: events(),
      close() {
        try {
          child.kill('SIGTERM');
        } catch {
          // best-effort
        }
        cleanup();
      },
    };
  }
}

export const codexAdapter: AgentAdapter = new CodexAdapterImpl();
