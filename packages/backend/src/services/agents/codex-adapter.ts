// Spawns the local `codex` CLI in non-interactive `exec --json` mode and
// translates its JSONL event stream into the same NormalizedEvent shape
// the Claude adapter produces.
//
// Codex CLI is single-prompt-per-invocation: each `codex exec` reads one
// prompt from stdin, runs one turn, and exits. To keep parity with Claude's
// "mid-run message injection" UX, we wrap that in a loop here:
//
//   while (stream still open):
//     pull next prompt (blocks if queue is empty)
//     spawn `codex exec resume <thread_id>` (or initial `codex exec`)
//     stream events, capture thread_id from thread.started
//     wait for child exit
//
// As long as the orchestrator keeps the run alive (i.e. doesn't call
// close()), pushing a new message resumes the same codex thread for the
// next turn. Closing the stream lets the loop exit cleanly.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { UserPromptStream } from './message-stream.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunArgs,
  NormalizedEvent,
  UserPrompt,
} from './types.js';

const CODEX_BIN = process.env.PINLOOM_CODEX_BIN ?? 'codex';

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

// TOML escaping for double-quoted basic strings. The TOML spec forbids
// raw control chars (U+0000..U+001F) and DEL (U+007F) in basic strings,
// so we encode the printable few directly and reject the rest. Today's
// callers (process.execPath, nanoid token, env vars) never contain
// control chars, but a future caller passing arbitrary user input could
// silently produce invalid TOML without this guard.
function tomlString(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code === 0x22) out += '\\"'; // "
    else if (code === 0x5c) out += '\\\\'; // \
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code === 0x7f) {
      // Other control chars get the \uXXXX escape per TOML §5.
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else out += ch;
  }
  return `"${out}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

// Build a temporary CODEX_HOME directory containing a generated
// `config.toml` with our MCP server block, plus a copy of the user's
// existing auth (`auth.json`) so the spawned codex still recognizes the
// logged-in account. Returns the directory path and the env overrides
// the caller should merge into the spawn env. Caller is responsible for
// cleaning up the directory.
function buildCodexHome(
  mcpServers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >,
): { dir: string; env: Record<string, string> } | null {
  const sourceHome =
    process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const dir = mkdtempSync(path.join(tmpdir(), 'pinloom-codex-home-'));

  // Bring over auth so the spawned codex stays logged in.
  for (const filename of ['auth.json', 'auth.json.bak']) {
    const src = path.join(sourceHome, filename);
    if (existsSync(src)) {
      try {
        copyFileSync(src, path.join(dir, filename));
      } catch {
        // best-effort — codex will surface its own auth errors if missing
      }
    }
  }

  const lines: string[] = [];
  // Inherit user's default model preference if set in their real config —
  // we intentionally don't copy the whole config.toml because the user's
  // own [mcp_servers.*] entries would shadow ours by name. Pinloom-side
  // model selection still works via --model flag downstream.
  for (const [name, server] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${tomlStringArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('[mcp_servers.' + name + '.env]');
      for (const [k, v] of Object.entries(server.env)) {
        lines.push(`${k} = ${tomlString(v)}`);
      }
    }
    lines.push('');
  }

  writeFileSync(path.join(dir, 'config.toml'), lines.join('\n'), 'utf8');

  return { dir, env: { CODEX_HOME: dir } };
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
    const promptStream = new UserPromptStream();
    promptStream.push(args.initialPrompt);

    let threadId: string | null = args.resume ?? null;
    let currentChild: ChildProcessWithoutNullStreams | null = null;
    let aborted = false;

    // Per-run isolated CODEX_HOME if the orchestrator needs MCP wiring.
    // Stays alive for the lifetime of the AgentRun (multiple turns reuse
    // the same config) and is wiped via cleanupCodexHome() — which is
    // idempotent and called from both the events generator's finally
    // AND close(), so the tmpdir is reaped no matter which path ends
    // the run.
    const codexHome = args.mcpServers
      ? buildCodexHome(args.mcpServers)
      : null;
    let codexHomeRemoved = false;
    function cleanupCodexHome() {
      if (!codexHome || codexHomeRemoved) return;
      codexHomeRemoved = true;
      try {
        rmSync(codexHome.dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    args.abortController.signal.addEventListener('abort', () => {
      aborted = true;
      promptStream.close();
      if (currentChild) {
        try {
          currentChild.kill('SIGTERM');
        } catch {
          // best-effort
        }
      }
    });

    function cliArgsFor(useResume: boolean): string[] {
      const base = [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
      ];
      if (useResume && threadId) {
        // `codex exec resume <ID> --json …`
        base.splice(1, 0, 'resume', threadId);
      }
      if (args.model) base.push('--model', args.model);
      return base;
    }

    function materializeImages(images: UserPrompt['images']): {
      tmpDir: string | null;
      flags: string[];
    } {
      if (!images || images.length === 0) return { tmpDir: null, flags: [] };
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'pinloom-codex-'));
      const flags: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = img.mimeType.split('/')[1] ?? 'png';
        const file = path.join(tmpDir, `img-${i}.${ext}`);
        writeFileSync(file, Buffer.from(img.base64, 'base64'));
        flags.push('--image', file);
      }
      return { tmpDir, flags };
    }

    async function* parseLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<string> {
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

    async function* runOneTurn(
      prompt: UserPrompt,
      isFirstTurn: boolean,
    ): AsyncGenerator<NormalizedEvent> {
      const useResume = !isFirstTurn || !!args.resume;
      const cliArgs = cliArgsFor(useResume);

      const { tmpDir, flags: imageFlags } = materializeImages(prompt.images);
      cliArgs.push(...imageFlags);

      // Compose stdin: systemPrompt is only included on the very first turn
      // (subsequent resumes already have it baked in via thread context).
      const stdinPayload =
        isFirstTurn && args.systemPrompt.length > 0
          ? `${args.systemPrompt}\n\n---\n\n${prompt.text}`
          : prompt.text;

      cliArgs.push('-');

      let child: ChildProcessWithoutNullStreams;
      try {
        const spawnEnv = codexHome
          ? { ...process.env, ...codexHome.env }
          : process.env;
        child = spawn(CODEX_BIN, cliArgs, {
          cwd: args.cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        currentChild = child;
      } catch (err) {
        if (tmpDir) {
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to spawn '${CODEX_BIN}' (is the Codex CLI installed?). ${message}`,
        );
      }

      try {
        child.stdin.write(stdinPayload);
        child.stdin.end();
      } catch {
        // best-effort — child may have already exited.
      }

      let stderrBuffer = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk;
      });

      try {
        for await (const line of parseLines(child)) {
          if (aborted) break;
          let parsed: CodexEvent;
          try {
            parsed = JSON.parse(line) as CodexEvent;
          } catch {
            continue;
          }

          if (parsed.type === 'thread.started' && parsed.thread_id) {
            threadId = parsed.thread_id;
            yield { type: 'session_id', id: parsed.thread_id };
            continue;
          }

          if (parsed.type === 'turn.completed') {
            yield { type: 'turn_complete' };
            continue;
          }

          if (parsed.type === 'item.completed' || parsed.type === 'item.started') {
            const item = parsed.item;
            if (!item) continue;

            if (item.type === 'agent_message' && parsed.type === 'item.completed') {
              const msg = item as CodexAgentMessage;
              if (typeof msg.text === 'string' && msg.text.length > 0) {
                yield { type: 'text_delta', text: msg.text };
                yield { type: 'text_block_end' };
              }
              continue;
            }

            if (item.type === 'reasoning' && parsed.type === 'item.completed') {
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
          if (child.exitCode !== null) resolve(child.exitCode);
          else child.once('close', (code) => resolve(code));
        });

        if (!aborted && exitCode !== 0 && exitCode !== null) {
          throw new Error(
            `codex exec exited with code ${exitCode}` +
              (stderrBuffer ? `: ${stderrBuffer.trim().slice(0, 500)}` : ''),
          );
        }
      } finally {
        if (currentChild === child) currentChild = null;
        if (tmpDir) {
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      }
    }

    async function* events(): AsyncGenerator<NormalizedEvent> {
      let isFirstTurn = true;
      try {
        while (!aborted) {
          const next = await promptStream.next();
          if (next === null) return;
          yield* runOneTurn(next, isFirstTurn);
          isFirstTurn = false;
        }
      } finally {
        if (currentChild) {
          try {
            currentChild.kill('SIGTERM');
          } catch {
            // best-effort
          }
        }
        cleanupCodexHome();
      }
    }

    return {
      events: events(),
      pushMessage(prompt: UserPrompt) {
        promptStream.push(prompt);
      },
      close() {
        promptStream.close();
        cleanupCodexHome();
      },
    };
  }
}

export const codexAdapter: AgentAdapter = new CodexAdapterImpl();
