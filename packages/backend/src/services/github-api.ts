// Minimal GitHub REST client used by the backup feature. We only need
// three things from the API surface:
//   1. validate that the user's PAT works and grab the login name,
//   2. list the user's repositories so they can pick one to back up to,
//   3. create a new private repository on demand.
// Everything else (push / clone) goes through `git` directly, where the
// token rides along inside the remote URL.

const GITHUB_API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

export interface GithubUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GithubRepoSummary {
  fullName: string; // "owner/name"
  name: string;
  private: boolean;
  cloneUrl: string; // https URL, no embedded token
  defaultBranch: string;
  updatedAt: string;
}

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GithubApiError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'pinloom-backup',
  };
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      ...headers(token),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { message?: string } = {};
    try {
      parsed = JSON.parse(text) as { message?: string };
    } catch {
      // non-JSON error body
    }
    throw new GithubApiError(
      parsed.message ?? `GitHub ${method} ${path} failed: ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export async function fetchAuthenticatedUser(token: string): Promise<GithubUser> {
  interface RawUser {
    login: string;
    name: string | null;
    avatar_url: string | null;
  }
  const u = await call<RawUser>('GET', '/user', token);
  return { login: u.login, name: u.name, avatarUrl: u.avatar_url };
}

export async function listUserRepos(token: string): Promise<GithubRepoSummary[]> {
  // Up to 100 most recently pushed repos. The backup picker shouldn't
  // need pagination for a personal account; if it ever does we can add
  // a `?page=` cursor here.
  interface RawRepo {
    full_name: string;
    name: string;
    private: boolean;
    clone_url: string;
    default_branch: string;
    updated_at: string;
  }
  const repos = await call<RawRepo[]>(
    'GET',
    '/user/repos?per_page=100&sort=pushed&affiliation=owner',
    token,
  );
  return repos.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    private: r.private,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));
}

export async function createRepo(
  token: string,
  args: { name: string; private?: boolean; description?: string },
): Promise<GithubRepoSummary> {
  interface RawRepo {
    full_name: string;
    name: string;
    private: boolean;
    clone_url: string;
    default_branch: string;
    updated_at: string;
  }
  const repo = await call<RawRepo>('POST', '/user/repos', token, {
    name: args.name,
    private: args.private ?? true,
    description: args.description ?? 'pinloom wiki backup',
    auto_init: true,
  });
  return {
    fullName: repo.full_name,
    name: repo.name,
    private: repo.private,
    cloneUrl: repo.clone_url,
    // GitHub returns 'main' on auto_init repos but be defensive.
    defaultBranch: repo.default_branch ?? 'main',
    updatedAt: repo.updated_at,
  };
}

// Embed the token into a clone URL for use with `git push`/`git clone`
// over HTTPS. The username slot is filled with a literal `x-access-token`
// per GitHub's docs, and the token rides in the password slot.
export function authenticatedRemoteUrl(cloneUrl: string, token: string): string {
  const u = new URL(cloneUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}
