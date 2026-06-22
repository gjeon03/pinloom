// User profile (docs/knowledge-system-v2.md, Phase 2 PR6). A single
// ~/.pinloom/wiki/USER.md capturing the user's preferences / working style —
// distinct from the project wiki (which is pointer-injected and
// project-scoped). The profile is INLINED into the static (cache-prefix) half
// of every system prompt, so it must stay bounded.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWikiRoot } from './wiki-reader.js';

// Reuse the Teams-instructions ceiling. It's inlined every turn (unlike the
// pointer-injected wiki), so the cap is a real token guardrail, not cosmetic.
export const USER_PROFILE_MAX = 4000;

export class UserProfileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'UserProfileError';
  }
}

// `root` is injectable for tests so we never touch the user's real wiki.
function profileFile(root?: string): string {
  return path.join(root ?? getWikiRoot(), 'USER.md');
}

export function readUserProfileSync(root?: string): string {
  try {
    const file = profileFile(root);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

export function getUserProfile(root?: string): string {
  return readUserProfileSync(root);
}

export async function setUserProfile(
  text: unknown,
  root?: string,
): Promise<string> {
  if (typeof text !== 'string') {
    throw new UserProfileError('profile must be a string');
  }
  if (text.length > USER_PROFILE_MAX) {
    throw new UserProfileError(
      `profile too long (max ${USER_PROFILE_MAX} chars)`,
    );
  }
  await mkdir(root ?? getWikiRoot(), { recursive: true });
  await writeFile(profileFile(root), text, 'utf8');
  return text;
}

// System-prompt block. Bounded with a truncate notice as defence in depth —
// the file could be hand-edited past the cap the API enforces.
export function buildUserProfileContext(root?: string): string {
  let text = readUserProfileSync(root).trim();
  if (!text) return '';
  let notice = '';
  if (text.length > USER_PROFILE_MAX) {
    text = text.slice(0, USER_PROFILE_MAX);
    notice = `\n\n*(profile truncated to the first ${USER_PROFILE_MAX} chars)*`;
  }
  return [
    '',
    '## About the user',
    '',
    "The user's stated preferences and working style (they maintain this in",
    'pinloom Settings). Honor it across every project:',
    '',
    text + notice,
  ].join('\n');
}
