#!/usr/bin/env node
/* eslint-disable no-console */
// Standalone PoC: see if `runAssistantWorker` actually opens a bridge to
// claude.ai with the user's existing Claude Code login. No pinloom wiring
// — just verify the connection succeeds, then idle until Ctrl-C.
//
// Run from the repo root:
//   pnpm --filter @pinloom/backend exec node scripts/remote-control-poc.mjs
//
// Or directly:
//   cd packages/backend && node scripts/remote-control-poc.mjs

import { runAssistantWorker } from '@anthropic-ai/claude-agent-sdk/assistant';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

function getAccessToken() {
  // Explicit env override wins (matches SDK's CLAUDE_CODE_OAUTH_TOKEN
  // fallback path).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (process.platform === 'darwin') {
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
      { encoding: 'utf-8' },
    ).trim();
    const parsed = JSON.parse(out);
    return parsed?.claudeAiOauth?.accessToken ?? undefined;
  }
  // Linux / Windows: SDK writes to <CONFIG_DIR>/.credentials.json
  const credPath = path.join(homedir(), '.claude', '.credentials.json');
  const raw = readFileSync(credPath, 'utf-8');
  return JSON.parse(raw)?.claudeAiOauth?.accessToken;
}

function getOrgUUID() {
  // Claude Code desktop / CLI caches the OAuth account into ~/.claude.json
  // after login. SDK doesn't refresh this — it's a static snapshot.
  const claudeJson = path.join(homedir(), '.claude.json');
  const raw = readFileSync(claudeJson, 'utf-8');
  return JSON.parse(raw)?.oauthAccount?.organizationUuid;
}

const accessToken = getAccessToken();
const orgUUID = getOrgUUID();

if (!accessToken) {
  console.error('[poc] no access token — run `claude login` or export CLAUDE_CODE_OAUTH_TOKEN');
  process.exit(1);
}
if (!orgUUID) {
  console.error('[poc] no orgUUID — could not read oauthAccount.organizationUuid from ~/.claude.json');
  process.exit(1);
}

console.log(`[poc] token: ${accessToken.slice(0, 12)}…[masked] (len=${accessToken.length})`);
console.log(`[poc] orgUUID: ${orgUUID.slice(0, 8)}…${orgUUID.slice(-4)}`);
console.log(`[poc] cwd: ${process.cwd()}`);

const controller = new AbortController();
process.on('SIGINT', () => {
  console.log('\n[poc] SIGINT — tearing down…');
  controller.abort();
});

const result = await runAssistantWorker({
  bridge: {
    dir: process.cwd(),
    getAccessToken: () => accessToken,
    baseUrl: 'https://api.anthropic.com',
    orgUUID,
    model: 'claude-sonnet-4-5',
    name: 'pinloom-remote-control-poc',
  },
  // Spread base so the worker keeps SDK-injected defaults (canUseTool,
  // resume, etc.). PoC adds nothing.
  buildQueryOptions: (base) => ({ ...base }),
  signal: controller.signal,
  log: (msg) => console.log(`[sdk] ${msg}`),
});

if (!result.ok) {
  console.error(`[poc] failed: kind=${result.error.kind} detail=${result.error.detail}`);
  process.exit(2);
}

console.log('[poc] connected!');
console.log(`[poc]   sessionUrl:        ${result.handle.sessionUrl}`);
console.log(`[poc]   bridgeSessionId:   ${result.handle.bridgeSessionId}`);
console.log(`[poc]   claudeSessionId:   ${result.handle.claudeSessionId ?? '(not yet — spawns on first prompt)'}`);
console.log('[poc] open claude.ai mobile/web — the worker should show up.');
console.log('[poc] Ctrl-C to teardown.');

await result.handle.done;
console.log('[poc] worker done — exiting.');
