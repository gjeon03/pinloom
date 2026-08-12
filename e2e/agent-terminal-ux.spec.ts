import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';

interface SeededSession {
  id: string;
  projectId: string;
  title: string | null;
  agent: 'claude' | 'codex';
  transport: 'terminal';
  [key: string]: unknown;
}

interface ContextFixture {
  sessionId: string;
  available: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  contextWindowTokens: number | null;
  observedCompactions: number;
  postCompactionInputTokens: number | null;
  rolloutBytes: number | null;
  updatedAt: string | null;
}

async function seedProject(
  request: APIRequestContext,
  suffix: string,
): Promise<string> {
  const response = await request.post('/api/projects', {
    data: { name: `Agent UX ${suffix}`, cwd: `/tmp/pinloom-agent-ux-${suffix}` },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function seedSession(
  request: APIRequestContext,
  projectId: string,
  agent: 'claude' | 'codex',
  title: string,
): Promise<SeededSession> {
  const response = await request.post(`/api/projects/${projectId}/sessions`, {
    data: { agent, title },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as SeededSession;
}

async function selectFullPreset(page: Page): Promise<void> {
  const full = page.getByRole('button', { name: /^Full\b/ });
  if (await full.isVisible()) await full.click();
}

function replayText(label: string): string {
  return Array.from(
    { length: 180 },
    (_, index) => `${label} line ${String(index).padStart(3, '0')} ${'x'.repeat(80)}`,
  ).join('\r\n');
}

async function terminalMetrics(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}> {
  return page.locator('.xterm-viewport:visible').evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

function bottomGap(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return Math.abs(metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

async function applyTestTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    localStorage.setItem('pinloom:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('agent terminal replay, follow-bottom, and session round trips', async ({
  page,
  request,
}, testInfo) => {
  const projectId = await seedProject(request, 'scroll');
  const first = await seedSession(request, projectId, 'codex', 'Codex terminal');
  const second = await seedSession(request, projectId, 'claude', 'Claude terminal');
  const sockets = new Map<string, Set<WebSocketRoute>>();
  const socketUrls: string[] = [];
  const clientMessages = new Map<string, string[]>();
  const postReplayMessages = new Map<string, string[]>();
  const pendingColdReplays = new Set<() => void>();
  let coldAttachReleased = false;

  await page.routeWebSocket(/\/ws\/agent-terminal/, (socket) => {
    const url = new URL(socket.url());
    const sessionId = url.searchParams.get('session');
    if (!sessionId) throw new Error('mock terminal socket requires session');
    const sessionSockets = sockets.get(sessionId) ?? new Set<WebSocketRoute>();
    sessionSockets.add(socket);
    sockets.set(sessionId, sessionSockets);
    socketUrls.push(socket.url());
    let replaySent = false;
    socket.onMessage((message) => {
      const raw = String(message);
      const messages = clientMessages.get(sessionId) ?? [];
      messages.push(raw);
      clientMessages.set(sessionId, messages);
      if (replaySent) {
        const postReplay = postReplayMessages.get(sessionId) ?? [];
        postReplay.push(raw);
        postReplayMessages.set(sessionId, postReplay);
      }
    });
    const deliverReplay = () => {
      if (replaySent) return;
      replaySent = true;
      socket.send(
        JSON.stringify({
          t: 'o',
          d: replayText(sessionId === first.id ? 'codex' : 'claude'),
          replay: true,
        }),
      );
    };
    if (sessionId === first.id && !coldAttachReleased) {
      pendingColdReplays.add(deliverReplay);
    } else {
      setTimeout(deliverReplay, 50);
    }
  });
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

  await page.goto(`/projects/${projectId}`);
  await selectFullPreset(page);
  await page.getByText('Codex terminal', { exact: true }).click();

  await expect.poll(() => sockets.get(first.id)?.size ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(1600);
  await page.locator('.xterm-screen:visible').click({ force: true });
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.press('a');
  expect(
    (clientMessages.get(first.id) ?? []).some((raw) => {
      const message = JSON.parse(raw) as { t?: unknown; d?: unknown };
      return message.t === 'i' && message.d === 'a';
    }),
  ).toBe(false);
  coldAttachReleased = true;
  for (const deliverReplay of pendingColdReplays) deliverReplay();
  pendingColdReplays.clear();
  await expect(page.getByText(/codex line 179 /)).toBeVisible();
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  await page.waitForTimeout(100);
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  const initialMetrics = await terminalMetrics(page);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await page.locator('.xterm-helper-textarea:visible').press('b');
  await expect
    .poll(() =>
      (clientMessages.get(first.id) ?? []).some((raw) => {
        const message = JSON.parse(raw) as { t?: unknown; d?: unknown };
        return message.t === 'i' && message.d === 'b';
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      (postReplayMessages.get(first.id) ?? []).some((raw) => {
        const message = JSON.parse(raw) as { t?: unknown; c?: unknown; r?: unknown };
        return (
          message.t === 'r' &&
          Number.isSafeInteger(message.c) &&
          Number.isSafeInteger(message.r)
        );
      }),
    )
    .toBe(true);
  expect(socketUrls.some((raw) => {
    const url = new URL(raw);
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    return cols >= 20 && cols <= 1000 && rows >= 5 && rows <= 500;
  })).toBe(true);

  const viewport = page.locator('.xterm-viewport:visible');
  await viewport.dispatchEvent('wheel', { deltaY: -5_000, deltaMode: 0 });
  await expect.poll(async () => (await terminalMetrics(page)).scrollTop).toBeLessThan(
    (await terminalMetrics(page)).scrollHeight -
      (await terminalMetrics(page)).clientHeight,
  );
  const away = await terminalMetrics(page);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  for (const socket of sockets.get(first.id) ?? []) {
    socket.send(JSON.stringify({ t: 'o', d: '\r\nlive output while reading' }));
  }
  await expect
    .poll(async () => Math.abs((await terminalMetrics(page)).scrollTop - away.scrollTop))
    .toBeLessThanOrEqual(1);
  const liveMetrics = await terminalMetrics(page);

  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await expect(page.locator('.xterm-helper-textarea:visible')).toBeFocused();
  const jumpedMetrics = await terminalMetrics(page);

  const roundTripMetrics: Array<{
    agent: 'claude' | 'codex';
    round: number;
    metrics: Awaited<ReturnType<typeof terminalMetrics>>;
  }> = [];
  for (let round = 0; round < 3; round += 1) {
    await page.getByText('Claude terminal', { exact: true }).click();
    await expect(page.getByText(/claude line 179 /)).toBeVisible();
    await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
    roundTripMetrics.push({ agent: 'claude', round, metrics: await terminalMetrics(page) });
    await page.getByText('Codex terminal', { exact: true }).click();
    await expect(page.getByText(/codex line 179 /)).toBeVisible();
    await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
    roundTripMetrics.push({ agent: 'codex', round, metrics: await terminalMetrics(page) });
  }

  await page.setViewportSize({ width: 1240, height: 760 });
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  const resizedMetrics = await terminalMetrics(page);

  await page.getByRole('button', { name: /Show history, pins & wiki/ }).click();
  const dragHandle = page.getByTitle('Drag to resize');
  const handleBox = await dragHandle.boundingBox();
  if (!handleBox) throw new Error('side-panel resize handle has no bounding box');
  const beforeRailResize = await terminalMetrics(page);
  const beforeRailWidth = await viewport.evaluate((element) => element.clientWidth);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 80, handleBox.y + handleBox.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await viewport.evaluate((element) => element.clientWidth)) - beforeRailWidth))
    .toBeGreaterThan(1);
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  const railResizedMetrics = await terminalMetrics(page);

  const firstSocketCountBeforeReconnect = socketUrls.filter((url) =>
    url.includes(first.id),
  ).length;
  await viewport.hover({ force: true });
  await page.getByTitle('Reconnect terminal').click();
  await expect(page.getByText(/codex line 179 /)).toBeVisible();
  await expect.poll(async () => bottomGap(await terminalMetrics(page))).toBeLessThanOrEqual(1);
  await expect
    .poll(() => socketUrls.filter((url) => url.includes(first.id)).length)
    .toBeGreaterThan(firstSocketCountBeforeReconnect);
  const reconnectedMetrics = await terminalMetrics(page);
  expect(socketUrls.filter((url) => url.includes(first.id)).length).toBeGreaterThanOrEqual(4);
  expect(socketUrls.filter((url) => url.includes(second.id)).length).toBeGreaterThanOrEqual(3);
  await testInfo.attach('terminal-viewport-metrics', {
    body: JSON.stringify(
      {
        initialMetrics,
        away,
        liveMetrics,
        jumpedMetrics,
        roundTripMetrics,
        beforeRailResize,
        resizedMetrics,
        railResizedMetrics,
        reconnectedMetrics,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('native-first context guidance, focus, and collapsed status', async ({
  page,
  request,
}, testInfo) => {
  const projectId = await seedProject(request, 'context');
  const session = await seedSession(request, projectId, 'codex', 'Context terminal');
  let context: ContextFixture = {
    sessionId: session.id,
    available: true,
    inputTokens: 800,
    cachedInputTokens: 0,
    contextWindowTokens: 1_000,
    observedCompactions: 0,
    postCompactionInputTokens: null,
    rolloutBytes: 100,
    updatedAt: new Date().toISOString(),
  };
  let terminalSocket: WebSocketRoute | null = null;
  const sessionSockets = new Map<string, Set<WebSocketRoute>>();

  await page.route(`**/api/sessions/${session.id}/codex-context`, async (route) => {
    await route.fulfill({ status: 200, json: context });
  });
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
  await page.routeWebSocket(/\/ws\/agent-terminal/, (socket) => {
    terminalSocket = socket;
    socket.onMessage(() => undefined);
    setTimeout(() => {
      socket.send(JSON.stringify({ t: 'o', d: replayText('context'), replay: true }));
    }, 50);
  });
  await page.routeWebSocket(
    (url) =>
      url.pathname === '/ws' &&
      url.searchParams.get('channel')?.startsWith('session:') === true,
    (socket) => {
      const channel = new URL(socket.url()).searchParams.get('channel');
      if (!channel) throw new Error('mock session socket requires channel');
      const sessionId = channel.slice('session:'.length);
      const sockets = sessionSockets.get(sessionId) ?? new Set<WebSocketRoute>();
      sockets.add(socket);
      sessionSockets.set(sessionId, sockets);
      socket.onMessage(() => undefined);
    },
  );

  await page.goto(`/projects/${projectId}`);
  await selectFullPreset(page);
  await page.getByText('Context terminal', { exact: true }).click();
  const expand = page.getByRole('button', { name: /Show history, pins & wiki/ });
  await expand.click();

  await expect(page.getByText(/automatically compacts context/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to a fresh thread' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse' }).click();
  await expect(
    page.getByRole('button', {
      name: /Show history, pins & wiki\. Codex context usage is high/,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Show history, pins & wiki/ }).click();

  const pushContext = async (next: ContextFixture) => {
    context = next;
    const sockets = sessionSockets.get(session.id);
    if (!sockets || sockets.size === 0) {
      throw new Error('session WebSocket not found');
    }
    const event = JSON.stringify({
      type: 'codex_context_updated',
      sessionId: session.id,
      context: next,
    });
    for (const socket of sockets) socket.send(event);
  };

  await pushContext({
    ...context,
    inputTokens: 900,
    updatedAt: new Date().toISOString(),
  });
  await expect(page.getByRole('button', { name: 'Switch to a fresh thread' })).toBeVisible();
  await applyTestTheme(page, 'light');
  await testInfo.attach('context-critical-light', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const action = page.getByRole('button', { name: 'Switch to a fresh thread' });
  const actionBox = await action.boundingBox();
  expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  await action.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(action).toBeFocused();
  expect(
    await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.matches(':focus-visible') &&
        (style.boxShadow !== 'none' || style.outlineStyle !== 'none')
      );
    }),
  ).toBe(true);
  await action.click();
  const cancel = page.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(action).toBeFocused();
  await action.click();
  await expect(cancel).toBeVisible();
  await cancel.focus();

  await pushContext({
    ...context,
    inputTokens: 500,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(page.getByText(/automatically compacts context/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Codex context' })).toBeFocused();

  await pushContext({
    ...context,
    inputTokens: 900,
    observedCompactions: 1,
    postCompactionInputTokens: 800,
    updatedAt: new Date(Date.now() + 2_000).toISOString(),
  });
  await expect(page.getByText(/remains high after automatic compaction/)).toBeVisible();
  await applyTestTheme(page, 'dark');
  await testInfo.attach('context-recommended-dark', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Collapse' }).click();
  await expect(
    page.getByRole('button', {
      name: /Show history, pins & wiki\. Codex context usage is critical/,
    }),
  ).toBeVisible();
  expect(terminalSocket).not.toBeNull();
});
