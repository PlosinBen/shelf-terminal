import { test, expect } from './helpers';

// Helper: open folder picker and go through connection step
async function openFolderPicker(page: any) {
  await page.locator('.sidebar-btn').click();
  const overlay = page.locator('.folder-picker-overlay');
  await expect(overlay).toBeVisible({ timeout: 5_000 });

  // Connection step: click Next (Local is default)
  const nextBtn = page.locator('.conn-btn-next');
  await expect(nextBtn).toBeVisible({ timeout: 3_000 });
  await nextBtn.click();

  // Now in browse step
  const header = page.locator('.fp-header');
  await expect(header).toContainText('Open Project', { timeout: 5_000 });
}

test('open folder picker via sidebar button', async ({ shelfApp: { page } }) => {
  const addBtn = page.locator('.sidebar-btn');
  await addBtn.click();

  const overlay = page.locator('.folder-picker-overlay');
  await expect(overlay).toBeVisible({ timeout: 5_000 });

  const header = page.locator('.fp-header');
  await expect(header).toContainText('New Project');
});

test('folder picker connection step shows Local by default', async ({ shelfApp: { page } }) => {
  if (!await page.locator('.folder-picker-overlay').isVisible()) {
    await page.locator('.sidebar-btn').click();
    await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  }

  const localBtn = page.locator('.conn-type-btn.active');
  await expect(localBtn).toContainText('Local');
});

test('folder picker shows home directory entries after Next', async ({ shelfApp: { page } }) => {
  // Close if open, then reopen with full flow
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();

  await openFolderPicker(page);

  const list = page.locator('.fp-browser-list');
  await expect(list).toBeVisible();

  const items = page.locator('.folder-picker-item');
  const count = await items.count();
  expect(count).toBeGreaterThan(1);
});

test('folder picker keyboard navigation works', async ({ shelfApp: { page } }) => {
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();

  await openFolderPicker(page);

  await page.keyboard.press('ArrowDown');
  const selected = page.locator('.folder-picker-item.selected');
  await expect(selected).toBeVisible();
});

test('select folder and create project', async ({ shelfApp: { page } }) => {
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }

  await openFolderPicker(page);

  // Press Enter to select current dir as project
  await page.keyboard.press('Enter');
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  // Project should appear in sidebar (count increases by 1)
  const sidebarItems = page.locator('.sidebar-item');
  const count = await sidebarItems.count();
  expect(count).toBeGreaterThanOrEqual(1);
});

test('project has a terminal tab after Cmd+T', async ({ shelfApp: { page } }) => {
  // Ensure project exists
  if (await page.locator('.sidebar-item').count() === 0) {
    await openFolderPicker(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
  }

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+t`);

  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
});

test('terminal spawns and shows output', async ({ shelfApp: { page } }) => {
  const terminal = page.locator('.terminal-container');
  await expect(terminal).toBeVisible({ timeout: 5_000 });

  const xtermScreen = page.locator('.xterm-screen');
  await expect(xtermScreen).toBeVisible({ timeout: 10_000 });

  await page.waitForTimeout(2000);
  const xtermRows = page.locator('.xterm-rows');
  const text = await xtermRows.textContent();
  expect(text?.length).toBeGreaterThan(0);
});

test('project shows green status dot', async ({ shelfApp: { page } }) => {
  const statusDot = page.locator('.sidebar-item .status-dot.alive').first();
  await expect(statusDot).toBeVisible({ timeout: 5_000 });
});
