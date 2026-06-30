import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Feature-gating matrix: each flag OFF must hide ALL its shell-level surfaces
// (sidebar nav, top-right cluster, deep-link route), and ON must show them.
// Session-level surfaces (side-panel tabs, chat pickers) are covered separately.
// Inlined config object (no @pinloom/shared import) to keep the spec standalone.

const FULL = {
  version: 1,
  preset: 'full',
  features: {
    teams: true, wiki: true, timeline: true, recap: true,
    notepad: true, templates: true, scheduleBot: true, skillBot: true,
    globalSearch: true, pins: true, sessionWikiTab: true, history: true,
  },
  pickers: {
    model: { mode: 'shown', fixed: 'claude-opus-4-8' },
    effort: { mode: 'shown', fixed: 'default' },
    transport: { mode: 'shown', fixed: 'terminal' },
  },
  locale: 'en',
};

type FeatureKey = keyof typeof FULL.features;

async function setConfig(request: APIRequestContext, cfg: unknown) {
  const res = await request.put('/api/settings/ui-config', { data: cfg });
  if (!res.ok()) throw new Error(`setConfig failed: ${res.status()} ${await res.text()}`);
}
function featureOff(key: FeatureKey) {
  return { ...FULL, preset: 'custom', features: { ...FULL.features, [key]: false } };
}

// Stable locators for each shell surface.
const navItem = (page: Page, name: string) =>
  page.locator('aside').getByRole('button', { name, exact: true });
const clusterBtn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('feature gating matrix', () => {
  test('baseline — Full preset shows every shell surface', async ({ page, request }) => {
    await setConfig(request, FULL);
    await page.goto('/');
    for (const n of ['Teams', 'Wiki', 'Timeline', 'Recap']) {
      await expect(navItem(page, n), `nav ${n}`).toBeVisible();
    }
    await expect(clusterBtn(page, 'Search history (⌘K)')).toBeVisible();
    await expect(clusterBtn(page, 'Prompt templates')).toBeVisible();
    await expect(clusterBtn(page, 'Notepad')).toBeVisible();
    await expect(clusterBtn(page, 'Schedule bot')).toBeVisible();
  });

  // nav + deep-link route per workspace feature
  for (const { key, nav, route } of [
    { key: 'teams' as const, nav: 'Teams', route: '/teams' },
    { key: 'wiki' as const, nav: 'Wiki', route: '/wiki' },
    { key: 'timeline' as const, nav: 'Timeline', route: '/timeline' },
    { key: 'recap' as const, nav: 'Recap', route: '/recap' },
  ]) {
    test(`${key} OFF — hides nav + redirects ${route}`, async ({ page, request }) => {
      await setConfig(request, featureOff(key));
      await page.goto('/');
      await expect(navItem(page, nav)).toHaveCount(0);
      // a sibling stays (no over-gating)
      const sibling = key === 'teams' ? 'Wiki' : 'Teams';
      await expect(navItem(page, sibling)).toBeVisible();
      // deep link bounces to home
      await page.goto(route);
      await expect(page).toHaveURL(/localhost:4747\/$/);
    });
  }

  test('globalSearch OFF — hides ⌘K search button', async ({ page, request }) => {
    await setConfig(request, featureOff('globalSearch'));
    await page.goto('/');
    await expect(clusterBtn(page, 'Search history (⌘K)')).toHaveCount(0);
    await expect(clusterBtn(page, 'Prompt templates')).toBeVisible();
  });

  test('templates OFF — hides prompt-templates button', async ({ page, request }) => {
    await setConfig(request, featureOff('templates'));
    await page.goto('/');
    await expect(clusterBtn(page, 'Prompt templates')).toHaveCount(0);
  });

  test('notepad OFF — hides notepad toggle', async ({ page, request }) => {
    await setConfig(request, featureOff('notepad'));
    await page.goto('/');
    await expect(clusterBtn(page, 'Notepad')).toHaveCount(0);
  });

  test('both bots OFF — hides the bot launcher entirely', async ({ page, request }) => {
    await setConfig(request, {
      ...FULL,
      preset: 'custom',
      features: { ...FULL.features, scheduleBot: false, skillBot: false },
    });
    await page.goto('/');
    await expect(clusterBtn(page, 'Schedule bot')).toHaveCount(0);
    await expect(clusterBtn(page, 'Skill bot')).toHaveCount(0);
  });

  test('only skillBot on — launcher shows, schedule hidden', async ({ page, request }) => {
    await setConfig(request, {
      ...FULL,
      preset: 'custom',
      features: { ...FULL.features, scheduleBot: false, skillBot: true },
    });
    await page.goto('/');
    await expect(clusterBtn(page, 'Skill bot')).toBeVisible();
    await expect(clusterBtn(page, 'Schedule bot')).toHaveCount(0);
  });

  test('locale ko — translates UI labels (proper nouns stay English)', async ({ page, request }) => {
    await setConfig(request, { ...FULL, locale: 'ko' });
    await page.goto('/');
    // home empty-state text is translated…
    await expect(page.getByText('왼쪽에서', { exact: false })).toBeVisible();
    // …but the Wiki/Teams proper nouns stay English in the nav
    await expect(navItem(page, 'Wiki')).toBeVisible();
  });
});
