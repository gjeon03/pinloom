// Helpers for pulling Claude Code's existing OAuth credentials so the
// remote-control adapter can connect to the Anthropic bridge without
// bothering the user with a separate login flow.
//
// `claude login` writes credentials to:
//   - macOS Keychain (service: "Claude Code-credentials", account: $USER)
//   - Linux / Windows: <CONFIG_DIR>/.credentials.json
//
// `~/.claude.json.oauthAccount.organizationUuid` is the orgUUID needed for
// bridge session creation. The SDK doesn't expose an API for it; we read
// the file Claude Code itself caches after login.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * Look up the current Claude Code OAuth access token. Returns undefined
 * if not found — caller should surface as "user needs to log in".
 *
 * Resolution order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env (explicit override / containers)
 *   2. macOS Keychain ("Claude Code-credentials" service)
 *   3. ~/.claude/.credentials.json (Linux / Windows fallback)
 */
export function getAccessToken(): string | undefined {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.length > 0) return envToken;

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        [
          'find-generic-password',
          '-s',
          'Claude Code-credentials',
          '-a',
          userInfo().username,
          '-w',
        ],
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const parsed = JSON.parse(out) as {
        claudeAiOauth?: { accessToken?: unknown };
      };
      const token = parsed?.claudeAiOauth?.accessToken;
      return typeof token === 'string' && token.length > 0 ? token : undefined;
    } catch {
      // keychain miss or `security` failed — fall through to file lookup
    }
  }

  try {
    const credPath = path.join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the user's Claude organization UUID from ~/.claude.json. Claude
 * Code desktop / CLI caches this after login; we don't refetch (the SDK
 * doesn't expose an API for it, and the cache stays accurate as long as
 * the user doesn't switch orgs).
 */
export function getOrgUUID(): string | undefined {
  try {
    const claudeJson = path.join(homedir(), '.claude.json');
    const raw = readFileSync(claudeJson, 'utf-8');
    const parsed = JSON.parse(raw) as {
      oauthAccount?: { organizationUuid?: unknown };
    };
    const uuid = parsed?.oauthAccount?.organizationUuid;
    return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined;
  } catch {
    return undefined;
  }
}

// In-process cache so each remote-control session start doesn't re-shell
// out to `security` (which can re-prompt for keychain unlock on locked
// systems) and re-read ~/.claude.json. Invalidated when the bridge
// rejects with 401 — see `invalidateRemoteCredentials`.
let cachedCredentials: { accessToken: string; orgUUID: string } | null = null;

/**
 * Convenience: both credentials at once, throwing if either is missing.
 * Use at remote-control startup so the failure surfaces immediately
 * instead of bubbling out as an opaque bridge error.
 */
export function loadRemoteCredentials(): {
  accessToken: string;
  orgUUID: string;
} {
  if (cachedCredentials) return cachedCredentials;
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new CredentialError(
      'No Claude OAuth access token. Run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN.',
    );
  }
  const orgUUID = getOrgUUID();
  if (!orgUUID) {
    throw new CredentialError(
      'No Claude organization UUID found in ~/.claude.json (oauthAccount.organizationUuid). Run Claude Code at least once to populate it.',
    );
  }
  cachedCredentials = { accessToken, orgUUID };
  return cachedCredentials;
}

/**
 * Clear the in-process credential cache. Call from `onAuth401` (PR 3) so
 * the next `loadRemoteCredentials()` re-reads from the keychain — which
 * Claude Code itself refreshes in the background after token rotation.
 */
export function invalidateRemoteCredentials(): void {
  cachedCredentials = null;
}
