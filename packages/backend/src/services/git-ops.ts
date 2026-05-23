// Thin wrappers around the system `git` binary. We deliberately do not
// pull in an in-process git library (isomorphic-git etc.) — the backup
// feature is local-only and the user already has `git` available; an
// extra ~1MB of bundled JS just to avoid a child_process spawn isn't
// worth it.

import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        // Quiet the credential helper — we embed the token in the
        // remote URL so prompts shouldn't appear, but if anything does
        // go wrong we don't want git to hang waiting on a TTY.
        GIT_TERMINAL_PROMPT: '0',
        ...(options.env ?? {}),
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new GitError(
            `git ${args.join(' ')} exited with ${code}: ${stderr.trim() || stdout.trim()}`,
            code,
            stderr,
          ),
        );
      }
    });
  });
}

export async function clone(
  remoteUrl: string,
  dest: string,
): Promise<SpawnResult> {
  // Allow cloning into an existing empty directory by passing `.` after
  // moving into it; simpler to just hand git the destination path.
  return runGit(['clone', remoteUrl, dest]);
}

export async function pullFastForward(cwd: string): Promise<SpawnResult> {
  return runGit(['pull', '--ff-only'], { cwd });
}

export async function addAll(cwd: string): Promise<SpawnResult> {
  return runGit(['add', '-A'], { cwd });
}

export async function status(cwd: string): Promise<SpawnResult> {
  return runGit(['status', '--porcelain'], { cwd });
}

export interface CommitResult {
  committed: boolean;
  message: string;
}

export async function commit(
  cwd: string,
  args: { message: string; authorName: string; authorEmail: string },
): Promise<CommitResult> {
  // Probe first — a no-op commit fails noisily otherwise. We rely on
  // `status --porcelain`'s emptiness because diff-index can lie when
  // a fresh clone hasn't computed indexes yet.
  const s = await status(cwd);
  if (s.stdout.trim().length === 0) {
    return { committed: false, message: 'nothing to commit' };
  }
  await runGit(
    [
      '-c',
      `user.name=${args.authorName}`,
      '-c',
      `user.email=${args.authorEmail}`,
      'commit',
      '-m',
      args.message,
    ],
    { cwd },
  );
  return { committed: true, message: args.message };
}

export async function push(cwd: string): Promise<SpawnResult> {
  return runGit(['push'], { cwd });
}

export async function setRemoteUrl(cwd: string, url: string): Promise<SpawnResult> {
  return runGit(['remote', 'set-url', 'origin', url], { cwd });
}

// Confirm the working tree at `dir` is actually a git checkout.
// Avoids handing a bare directory to `git pull` / `add` etc., which
// produces confusing error output.
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function getRemoteUrl(
  cwd: string,
  remote = 'origin',
): Promise<string | null> {
  try {
    const res = await runGit(['remote', 'get-url', remote], { cwd });
    return res.stdout.trim();
  } catch {
    return null;
  }
}
