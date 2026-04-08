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

test('sidebar has settings and new project buttons', async ({ shelfApp: { page } }) => {
  const actions = page.locator('.sidebar-header-actions .sidebar-btn');
  await expect(actions).toHaveCount(2);
});

test('no projects on fresh start', async ({ shelfApp: { page } }) => {
  const items = page.locator('.sidebar-item');
  await expect(items).toHaveCount(0);
});
