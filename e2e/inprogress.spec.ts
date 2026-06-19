import { test, expect } from '@playwright/test';

// Verifies PR #116: the notification bell has an "In progress" tab, and a
// running session (delivered via the global run_activity WS) shows up there
// across projects. Runs against the isolated 6751/6748 instance.

test.describe('notification In-progress tab', () => {
  test('bell shows an "In progress" filter tab', async ({ page, request }) => {
    await request.post('http://localhost:6751/api/projects', {
      data: { name: 'E2E-A', cwd: '/tmp/e2e-inprog-a' },
    });
    await page.goto('/');

    await page.locator('button[title="Notifications"]').click();

    // The four filter tabs, including the new In-progress one (#116).
    await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^In progress/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
  });

  test('a running session (via run_activity) appears in the In-progress tab', async ({
    page,
    request,
  }) => {
    await request.post('http://localhost:6751/api/projects', {
      data: { name: 'E2E-B', cwd: '/tmp/e2e-inprog-b' },
    });
    // Capture the app's real WebSocket instances (no interception — the app
    // stays fully connected to the backend) so we can dispatch a synthetic
    // run_activity onto the genuine `runs` socket, exactly as the backend
    // would broadcast it when a session in any project begins a turn.
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      (window as unknown as { __ws: WebSocket[] }).__ws = [];
      class Tracked extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          (window as unknown as { __ws: WebSocket[] }).__ws.push(this);
        }
      }
      window.WebSocket = Tracked as unknown as typeof WebSocket;
    });

    await page.goto('/');

    // Push the started event onto the live runs socket.
    await page.waitForFunction(() =>
      (window as unknown as { __ws: WebSocket[] }).__ws.some((w) =>
        w.url.includes('channel=runs'),
      ),
    );
    await page.evaluate((payload) => {
      const ws = (window as unknown as { __ws: WebSocket[] }).__ws.find((w) =>
        w.url.includes('channel=runs'),
      );
      ws?.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, JSON.stringify({
      type: 'run_activity',
      sessionId: 'sess-e2e-1',
      projectId: 'proj-e2e-1',
      title: 'Coupon work',
      agent: 'claude',
      phase: 'started',
    }));

    // The bell should now show a running count and pulse.
    const bell = page.locator('button[title="Notifications"]');
    await bell.click();

    // Switch to the In-progress tab and assert our running session is listed.
    await page.getByRole('button', { name: /^In progress/ }).click();
    await expect(page.getByText('Coupon work')).toBeVisible();
    await expect(page.getByText(/running/)).toBeVisible();

    // The In-progress tab label carries the live count.
    await expect(page.getByRole('button', { name: /In progress \(1\)/ })).toBeVisible();
  });
});
