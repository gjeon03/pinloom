// Capture screenshots + a single video of the main pinloom surfaces so the
// README and the Reddit post have real, reproducible artifacts. This spec
// is deliberately independent from smoke.spec.ts — it never deletes data,
// runs against its own throwaway SQLite (see walkthrough.config.ts), and
// seeds projects via the API so it doesn't need a real OS file picker.
//
// Pre-seeded wiki pages on disk give the Wiki screenshot real content
// (rather than an empty-state "No pages yet" placeholder) without needing
// to invoke a Claude sync agent during the test.
//
// The chat history holds a real Claude question-and-answer turn:
//   - The user prompt is typed into the spec.
//   - The assistant reply comes from spawning `claude -p` against the
//     host's installed Claude Code CLI (the `@anthropic-ai/claude-agent-sdk`
//     native binary picker prefers a musl build that fails to run on
//     glibc Linux, so we bypass it).
//   - The reply is inserted as an assistant message via direct SQLite,
//     then pinned via PATCH /api/messages — the pin reflects an actual
//     Claude answer, not a faked shell-output stand-in.

import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const Database = require('../packages/backend/node_modules/better-sqlite3');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_CWD = '/tmp/pinloom-demo';
const SHOTS_DIR = path.join(HERE, 'artifacts', 'screenshots');
// The prompt and the Claude reply are both pre-fetched in
// walkthrough.config.ts — that way the slow CLI call happens BEFORE the
// per-test video context starts recording, instead of bookending the
// recording with ~10s of blank tab.
const USER_PROMPT = process.env.PINLOOM_WALKTHROUGH_PROMPT;
const ASSISTANT_REPLY = process.env.PINLOOM_WALKTHROUGH_CLAUDE_REPLY;
if (!USER_PROMPT || !ASSISTANT_REPLY) {
  throw new Error(
    'Walkthrough env not initialized — run via walkthrough.config.ts',
  );
}
const PIN_TITLE = 'writeFileSync vs fs.promises.writeFile';

async function snap(page: Page, name: string) {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS_DIR, `${name}.png`),
    fullPage: false,
  });
}

// Beat: pause briefly so the recorded video has a readable scene before
// the next action. Use sparingly — only at narrative boundaries between
// screenshots, not as a flake hammer. Assertions still use auto-wait.
async function beat(page: Page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function seedProject(
  request: APIRequestContext,
  name: string,
  cwd: string,
) {
  const res = await request.post('/api/projects', { data: { name, cwd } });
  if (!res.ok()) {
    throw new Error(`seedProject failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; name: string };
}

async function seedSession(
  request: APIRequestContext,
  projectId: string,
  title: string,
) {
  const res = await request.post(`/api/projects/${projectId}/sessions`, {
    data: { title, agent: 'claude' },
  });
  if (!res.ok()) {
    throw new Error(`seedSession failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; title: string };
}

// Insert a user message + assistant reply pair directly into the temp
// SQLite. This bypasses the @anthropic-ai/claude-agent-sdk runtime so we
// don't depend on its (broken-on-glibc) native binary picker.
function insertChatTurn(args: {
  dbPath: string;
  sessionId: string;
  userContent: string;
  assistantContent: string;
}): { userId: string; assistantId: string } {
  const db = new Database(args.dbPath);
  try {
    const now = new Date();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const insert = db.prepare(
      `INSERT INTO messages (id, session_id, plan_item_id, role, content, tool_use, created_at)
       VALUES (?, ?, NULL, ?, ?, NULL, ?)`,
    );
    // 1ms gap keeps the natural ordering deterministic.
    insert.run(userId, args.sessionId, 'user', args.userContent, now.toISOString());
    insert.run(
      assistantId,
      args.sessionId,
      'assistant',
      args.assistantContent,
      new Date(now.getTime() + 1).toISOString(),
    );
    return { userId, assistantId };
  } finally {
    db.close();
  }
}

async function pinMessage(
  request: APIRequestContext,
  messageId: string,
  pinTitle: string,
) {
  const res = await request.patch(`/api/messages/${messageId}`, {
    data: { pinned: true, pinTitle },
  });
  if (!res.ok()) {
    throw new Error(`pinMessage failed: ${res.status()} ${await res.text()}`);
  }
}

async function seedWikiPages() {
  const home = process.env.PINLOOM_WALKTHROUGH_HOME;
  if (!home) throw new Error('PINLOOM_WALKTHROUGH_HOME not set by config');
  const pagesDir = path.join(home, '.pinloom', 'wiki', 'pages');
  await mkdir(pagesDir, { recursive: true });

  const pinloomDemoConventions = `---
applies_to: [pinloom-demo]
topic: [conventions, git]
related: [release-checklist-pinloom-demo.md]
summary: "Commit message and branch conventions for pinloom-demo"
---

# Git conventions — pinloom-demo

<!-- pinloom:auto-section -->

- **Commits**: Conventional Commits — \`feat:\`, \`fix:\`, \`docs:\`, \`chore:\`.
  Lowercase imperative subject, no trailing period.
- **Branch names**: \`feat/<slug>\` for features, \`fix/<slug>\` for bug
  fixes. \`main\` is protected.
- **PR titles**: match the commit message; do not include the PR number.

<!-- /pinloom:auto-section -->
`;

  const reactHooksPatterns = `---
applies_to: [global]
topic: [react, patterns]
related: []
summary: "Reusable hook patterns confirmed across multiple projects"
---

# React hook patterns

<!-- pinloom:auto-section -->

- Persist tab state in localStorage **synchronously inside the setter**
  rather than via a useEffect — avoids the race where switching back to
  a tab clobbers the just-saved value.
- For DOM cleanup in effects, always check \`document.contains(node)\`
  before \`node.remove()\` — React may have already unmounted it.

<!-- /pinloom:auto-section -->
`;

  const debugRunbook = `---
applies_to: [pinloom-demo]
topic: [debugging, runbook]
related: []
summary: "Common failure modes and where to look first"
---

# Debugging runbook — pinloom-demo

<!-- pinloom:auto-section -->

When the CLI hangs after \`add\`:
1. Check the lock file at \`/tmp/.pinloom-demo.lock\` is not stale.
2. \`lsof\` the data file to see if a previous run is still writing.

<!-- /pinloom:auto-section -->
`;

  await writeFile(
    path.join(pagesDir, 'git-conventions-pinloom-demo.md'),
    pinloomDemoConventions,
    'utf8',
  );
  await writeFile(
    path.join(pagesDir, 'react-hooks-patterns.md'),
    reactHooksPatterns,
    'utf8',
  );
  await writeFile(
    path.join(pagesDir, 'debug-runbook-pinloom-demo.md'),
    debugRunbook,
    'utf8',
  );
}

test.describe('walkthrough', () => {
  test('capture screenshots + video across main surfaces', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);

    // 1. Seed two projects + three wiki pages.
    const demoProject = await seedProject(request, 'pinloom-demo', DEMO_CWD);
    await seedProject(request, 'sample-blog', '/tmp/sample-blog-not-real');
    await seedWikiPages();

    // 2. Seed a session, persist the pre-fetched Q+A, pin the assistant
    //    answer. The Claude CLI call already happened in the config so
    //    the video doesn't open on 10s of blank.
    const session = await seedSession(
      request,
      demoProject.id,
      'Persist list to disk',
    );
    const dbPath = process.env.PINLOOM_WALKTHROUGH_DB;
    if (!dbPath) throw new Error('PINLOOM_WALKTHROUGH_DB not set by config');
    const { assistantId } = insertChatTurn({
      dbPath,
      sessionId: session.id,
      userContent: USER_PROMPT,
      assistantContent: ASSISTANT_REPLY,
    });
    await pinMessage(request, assistantId, PIN_TITLE);

    // 3. Opening shot — sidebar + main empty state.
    await page.goto('/');
    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('pinloom-demo', { exact: true })).toBeVisible();
    await snap(page, '01-sidebar-empty-state');
    await beat(page);

    // 4. Settings → Environment Variables.
    await sidebar.getByRole('button', { name: /^Settings$/ }).click();
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(settingsDialog).toBeVisible();
    await snap(page, '02-settings-modal');
    await beat(page);

    const envSection = page
      .locator('section', { has: page.getByText('Environment Variables') })
      .first();
    await envSection.getByRole('button', { name: /Add/ }).click();
    await page.getByPlaceholder('ASANA_TOKEN').fill('ASANA_TOKEN');
    await page.getByPlaceholder('paste token here').fill('demo-pat-xxxxxxxxxxxx');
    await page
      .getByPlaceholder('e.g. Asana personal access token')
      .fill('Asana personal access token');
    await snap(page, '03-env-var-add-form');
    await beat(page);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(envSection.getByText('ASANA_TOKEN')).toBeVisible();
    await snap(page, '04-env-var-saved');
    await beat(page);
    await settingsDialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(settingsDialog).toBeHidden();

    // 5. Project workspace — sidebar lands on the session that already
    //    has a real Claude Q&A turn with the answer pinned.
    await sidebar.getByText('pinloom-demo', { exact: true }).click();
    await expect(page).toHaveURL(/\/projects\//);
    await expect(
      page.getByText('Quick design call', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(PIN_TITLE, { exact: false })).toBeVisible();
    await beat(page);
    await snap(page, '05-project-workspace');

    // 6. Wiki dashboard.
    await sidebar.getByRole('button', { name: /^Wiki$/ }).click();
    await expect(page.getByRole('heading', { name: 'Wiki' })).toBeVisible();
    await expect(
      page.getByText('Git conventions — pinloom-demo', { exact: true }),
    ).toBeVisible();
    await beat(page);
    await snap(page, '06-wiki-populated');

    // 7. Wiki page detail.
    await page.getByText('Git conventions — pinloom-demo', { exact: true }).click();
    await expect(
      page.getByText('Conventional Commits', { exact: false }),
    ).toBeVisible();
    await beat(page);
    await snap(page, '07-wiki-page-detail');

    // 8. Wiki Analyze picker.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Wiki' })).toBeVisible();
    await page.getByRole('button', { name: /Analyze/ }).click();
    const analyzeDialog = page.getByRole('dialog', {
      name: 'Analyze project for conventions',
    });
    await expect(analyzeDialog).toBeVisible();
    await beat(page);
    await snap(page, '08-wiki-analyze-picker');
    await analyzeDialog
      .getByRole('button', { name: 'Close analyze picker' })
      .click();
    await expect(analyzeDialog).toBeHidden();

    // 9. Teams dashboard.
    await sidebar.getByRole('button', { name: /^Teams$/ }).click();
    await expect(page.getByRole('heading', { name: 'Teams' })).toBeVisible();
    await beat(page);
    await snap(page, '09-teams-empty');
  });
});
