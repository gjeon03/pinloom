import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import type { Message } from '@pinloom/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../ws/hub.js';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

function runBash(command: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, EXEC_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n[...output truncated]';
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n[...output truncated]';
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + String(err),
        exitCode: null,
        signal: null,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

interface SessionCwdRow {
  cwd: string;
}

function loadCwd(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.cwd
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as SessionCwdRow | undefined;
  return row?.cwd ?? null;
}

function persistMessage(args: {
  sessionId: string;
  role: 'user' | 'tool';
  content: string;
  toolUse?: unknown;
}): Message {
  const db = getDb();
  const id = nanoid();
  const now = new Date().toISOString();
  const toolUseJson = args.toolUse ? JSON.stringify(args.toolUse) : null;

  db.prepare(
    `INSERT INTO messages
       (id, session_id, plan_item_id, role, content, tool_use, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, args.sessionId, args.role, args.content, toolUseJson, now);

  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, args.sessionId);

  const message: Message = {
    id,
    sessionId: args.sessionId,
    planItemId: null,
    role: args.role,
    content: args.content,
    toolUse: toolUseJson,
    pinned: false,
    pinTitle: null,
    createdAt: now,
  };
  broadcast(`session:${args.sessionId}`, {
    type: 'message',
    sessionId: args.sessionId,
    message,
  });
  return message;
}

export async function execShellCommand(
  sessionId: string,
  command: string,
): Promise<{ userMessage: Message; toolMessage: Message }> {
  const cwd = loadCwd(sessionId);
  if (!cwd) throw new Error(`session ${sessionId} not found`);

  const userMessage = persistMessage({
    sessionId,
    role: 'user',
    content: `! ${command}`,
  });

  const result = await runBash(command, cwd);

  const summaryParts: string[] = [];
  if (result.stdout) summaryParts.push(result.stdout);
  if (result.stderr) {
    if (summaryParts.length > 0) summaryParts.push('\n[stderr]');
    summaryParts.push(result.stderr);
  }
  if (summaryParts.length === 0) summaryParts.push('(no output)');

  const exitLabel =
    result.signal != null
      ? `signal ${result.signal}`
      : result.exitCode == null
        ? 'unknown'
        : String(result.exitCode);

  const toolMessage = persistMessage({
    sessionId,
    role: 'tool',
    content: summaryParts.join('\n'),
    toolUse: {
      name: 'shell',
      input: {
        command,
        cwd,
      },
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
      },
    },
  });

  broadcast(`session:${sessionId}`, {
    type: 'run_log',
    sessionId,
    stream: 'stdout',
    chunk: `$ ${command}\n`,
  });
  if (result.stdout) {
    broadcast(`session:${sessionId}`, {
      type: 'run_log',
      sessionId,
      stream: 'stdout',
      chunk: result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`,
    });
  }
  if (result.stderr) {
    broadcast(`session:${sessionId}`, {
      type: 'run_log',
      sessionId,
      stream: 'stderr',
      chunk: result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`,
    });
  }
  broadcast(`session:${sessionId}`, {
    type: 'run_log',
    sessionId,
    stream: result.exitCode === 0 ? 'stdout' : 'stderr',
    chunk: `[exit ${exitLabel}]\n`,
  });

  return { userMessage, toolMessage };
}
