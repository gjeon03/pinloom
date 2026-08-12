import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';

interface SessionFixture {
  id: string;
  projectId: string;
  title: string | null;
}

function message(sessionId: string, index: number) {
  return {
    id: `${sessionId}-message-${index.toString().padStart(3, '0')}`,
    sessionId,
    planItemId: null,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `history ${sessionId} message ${index.toString().padStart(3, '0')} ${'detail '.repeat(12)}`,
    toolUse: null,
    pinned: false,
    pinTitle: null,
    pinnedAt: null,
    sourceMessageId: null,
    model: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

async function seedProject(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/projects', {
    data: { name: 'Claude pagination', cwd: '/tmp/pinloom-claude-pagination' },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function seedSession(
  request: APIRequestContext,
  projectId: string,
  title: string,
): Promise<SessionFixture> {
  const response = await request.post(`/api/projects/${projectId}/sessions`, {
    data: { agent: 'claude', title },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as SessionFixture;
}

async function mockMessagePages(
  page: Page,
  histories: Map<string, ReturnType<typeof message>[]>,
  requests: string[],
  settledRequests: string[],
): Promise<void> {
  await page.route(/\/api\/sessions\/[^/]+\/messages\/page/, async (route) => {
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split('/')[3] ?? '';
    const history = histories.get(sessionId) ?? [];
    const beforeRaw = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const end = beforeRaw === null ? history.length : Number(beforeRaw);
    const start = Math.max(0, end - limit);
    const requestKey = `${sessionId}:${beforeRaw ?? 'latest'}:${limit}`;
    requests.push(requestKey);
    if (beforeRaw !== null) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      status: 200,
      json: {
        items: history.slice(start, end),
        nextCursor: start > 0 ? String(start) : null,
      },
    });
    settledRequests.push(requestKey);
  });
}

test('Claude SDK chat pages backward while preserving anchors, live output, and search focus', async ({
  page,
  request,
}) => {
  const projectId = await seedProject(request);
  const first = await seedSession(request, projectId, 'Long Claude chat');
  const second = await seedSession(request, projectId, 'Second Claude chat');
  const histories = new Map([
    [first.id, Array.from({ length: 230 }, (_, index) => message(first.id, index))],
    [second.id, Array.from({ length: 12 }, (_, index) => message(second.id, index))],
  ]);
  const pageRequests: string[] = [];
  const settledPageRequests: string[] = [];
  const sessionSockets = new Map<string, Set<WebSocketRoute>>();

  await mockMessagePages(page, histories, pageRequests, settledPageRequests);
  await page.route('**/api/health', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        status: 'ok',
        agents: {
          claude: { installed: true, version: 'mock-claude' },
          codex: { installed: true, version: 'mock-codex' },
        },
      },
    });
  });
  await page.routeWebSocket(
    (url) => url.pathname === '/ws' && url.searchParams.get('channel')?.startsWith('session:') === true,
    (socket) => {
      const channel = new URL(socket.url()).searchParams.get('channel');
      if (!channel) throw new Error('missing session channel');
      const sessionId = channel.slice('session:'.length);
      const sockets = sessionSockets.get(sessionId) ?? new Set<WebSocketRoute>();
      sockets.add(socket);
      sessionSockets.set(sessionId, sockets);
      socket.onMessage(() => undefined);
    },
  );

  await page.goto(`/s/${first.id}`);
  await expect(page.getByText(/message 229/)).toBeVisible();
  await page.waitForTimeout(300);
  expect(pageRequests.filter((entry) => entry.startsWith(first.id))).toEqual([
    `${first.id}:latest:100`,
  ]);

  const scroller = page.locator('[data-testid="virtuoso-scroller"]');
  await expect(scroller).toBeVisible();
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  const anchor = page.getByText(/message 130/).first();
  await expect(anchor).toBeAttached();
  await expect.poll(() => pageRequests.filter((entry) => entry.startsWith(first.id)).length).toBeGreaterThan(1);
  await expect(anchor).toBeVisible();
  const beforePrepend = await anchor.boundingBox();
  await expect
    .poll(() => settledPageRequests.filter((entry) => entry.startsWith(first.id)).length)
    .toBeGreaterThan(1);
  await expect
    .poll(async () => {
      const afterPrepend = await anchor.boundingBox();
      return Math.abs((afterPrepend?.y ?? 0) - (beforePrepend?.y ?? 0));
    })
    .toBeLessThanOrEqual(3);

  const live = {
    ...message(first.id, 230),
    id: `${first.id}-message-live`,
    content: 'live message while reading older history',
  };
  const scrollBeforeLive = await scroller.evaluate((element) => element.scrollTop);
  for (const socket of sessionSockets.get(first.id) ?? []) {
    socket.send(JSON.stringify({ type: 'message', sessionId: first.id, message: live }));
  }
  await expect(page.getByRole('button', { name: /new|Jump to latest/ })).toBeVisible();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollBeforeLive, 0);

  await page.goto(`/s/${second.id}`);
  await expect(page.getByText(/message 011/)).toBeVisible();
  await expect(page.getByText(/message 229/)).toHaveCount(0);

  const targetId = `${first.id}-message-020`;
  await page.evaluate(
    ({ sessionId, messageId }) => {
      localStorage.setItem(`pinloom:focusMessage:${sessionId}`, messageId);
    },
    { sessionId: first.id, messageId: targetId },
  );
  await page.goto(`/s/${first.id}`);
  expect(await page.evaluate((key) => localStorage.getItem(key), `pinloom:focusMessage:${first.id}`))
    .toBe(targetId);
  await expect.poll(() => pageRequests.some((entry) => entry === `${first.id}:130:500`))
    .toBe(true);
  const target = page.getByText(/message 020/).first();
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();
  expect(targetBox?.y ?? 0).toBeGreaterThan(80);
  expect(targetBox?.y ?? 1_000).toBeLessThan(740);
  expect(pageRequests).toContain(`${first.id}:130:500`);
});
