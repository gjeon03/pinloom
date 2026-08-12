import { test, expect, type APIRequestContext } from '@playwright/test';

async function seedProject(
  request: APIRequestContext,
  name: string,
  cwd: string,
) {
  const res = await request.post('/api/projects', {
    data: { name, cwd },
  });
  if (!res.ok()) {
    throw new Error(`seedProject failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; name: string };
}

test.describe('smoke', () => {
  // No beforeEach cleanup: playwright.config.ts now starts a fresh server
  // with a fresh per-run SQLite file, so the test always begins empty.
  // The previous "delete all" pattern is what wiped production data when
  // reuseExistingServer was true.

  test('group lifecycle: create, persist on reload, delete (members survive)', async ({
    page,
    request,
  }) => {
    // 1. Seed two projects directly via API. The DirectoryPicker UI requires
    //    a real filesystem path that exists on the runner, which we skip.
    await seedProject(request, 'Alpha', '/tmp/alpha');
    await seedProject(request, 'Beta', '/tmp/beta');

    // 2. Open the app on the catchall route — sidebar renders unconditionally.
    await page.goto('/');

    // A fresh isolated database shows the one-time feature preset chooser.
    // Select Full so the group controls exercised below are enabled.
    const fullPreset = page.getByRole('button', { name: /^Full\b/ });
    await expect(fullPreset).toBeVisible();
    await fullPreset.click();
    await expect(fullPreset).toHaveCount(0);

    // Scope all sidebar assertions to <aside> so ProjectPage's own copy of
    // the project name (when a project is active) doesn't trip strict-mode.
    const sidebar = page.locator('aside');

    // 3. Both projects appear in the sidebar.
    await expect(sidebar.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Beta', { exact: true })).toBeVisible();

    // 4. Click a project — URL changes to /projects/:id.
    await sidebar.getByText('Alpha', { exact: true }).click();
    await expect(page).toHaveURL(/\/projects\//);

    // 5. Create a group through the app's Electron-safe text prompt modal.
    await page.getByRole('button', { name: 'New group' }).click();
    const groupDialog = page.getByRole('dialog', { name: 'New group name' });
    await groupDialog.getByRole('textbox', { name: 'New group name' }).fill('Work');
    await groupDialog.getByRole('button', { name: 'Create' }).click();
    await expect(sidebar.getByText('Work', { exact: true })).toBeVisible();

    // 6. Reload — group persists (server-backed, not just client state).
    await page.reload();
    await expect(sidebar.getByText('Work', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Beta', { exact: true })).toBeVisible();

    // 7. Open the group's ⋯ menu and delete. handleDeleteGroup uses
    //    window.confirm; intercept it.
    await page.getByRole('button', { name: 'Group options' }).click();
    page.once('dialog', (dialog) => {
      expect(dialog.type()).toBe('confirm');
      void dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete' }).click();

    // 8. Group gone, member projects still present (FK SET NULL — projects
    //    fall back to Ungrouped instead of cascading).
    await expect(sidebar.getByText('Work', { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Beta', { exact: true })).toBeVisible();
  });
});
