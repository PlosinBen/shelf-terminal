import { test, expect } from './helpers';

test('app window opens with correct layout', async ({ shelfApp: { page } }) => {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  const header = page.locator('.sidebar-header');
  await expect(header).toContainText('Shelf');

  const mainArea = page.locator('.main-area');
  await expect(mainArea).toBeVisible();

  const tabBar = page.locator('.tab-bar');
  await expect(tabBar).toBeVisible();
});

test('sidebar header actions stay out of sequential focus order', async ({ shelfApp: { page } }) => {
  const actions = page.locator('.sidebar-header-actions .sidebar-btn');
  await expect(actions).toHaveCount(3);

  for (let i = 0; i < 3; i++) {
    await expect(actions.nth(i)).toHaveAttribute('tabindex', '-1');
  }

  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar-header-actions'))).toBe(false);
  }
});

test('no projects on fresh start', async ({ shelfApp: { page } }) => {
  const items = page.locator('.sidebar-item');
  await expect(items).toHaveCount(0);
});
