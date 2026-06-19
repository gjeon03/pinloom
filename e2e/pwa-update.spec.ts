import { test, expect } from '@playwright/test';

// Verifies the PWA auto-reload (src/stores/pwaUpdate.ts): the OPEN tab reloads
// itself when a new build's service worker takes control, but does NOT reload
// on the very first install. We can't run two real builds in one test, so we
// drive the `controllerchange` signal directly (the same event the browser
// fires when a freshly-activated SW claims the page).

test.describe('PWA auto-update', () => {
  test('reloads on SW control change, but not on first install', async ({ page }) => {
    await page.goto('/');

    // Wait until the SW has claimed the page (controller set). The initial
    // claim's controllerchange is the "first install" one, which the handler
    // skips — so reaching here means no reload happened on first install.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 15_000,
    });

    // Tag this document instance; a reload makes a fresh document without it.
    await page.evaluate(() => {
      (window as unknown as { __probe: boolean }).__probe = true;
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { __probe?: boolean }).__probe === true,
      ),
    ).toBe(true);

    // Simulate a NEW build's SW taking control.
    await page.evaluate(() =>
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange')),
    );

    // The handler should reload → the probe is gone on the fresh document.
    await page.waitForFunction(
      () => (window as unknown as { __probe?: boolean }).__probe === undefined,
      null,
      { timeout: 15_000 },
    );
  });
});
