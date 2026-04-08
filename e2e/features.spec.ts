import { test, expect } from './helpers';

// Helper: create a project and open a tab
async function setupProject(page: any) {
  await page.locator('.sidebar-btn').click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  // Click Next (Local default)
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  // Select current dir
  await page.keyboard.press('Enter');
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  // Connect by clicking the connect prompt
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(1000);
}

test('search bar opens with mod+F and closes with Escape', async ({ shelfApp: { page } }) => {
  await setupProject(page);

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+f`);
  const searchBar = page.locator('.search-bar');
  await expect(searchBar).toBeVisible({ timeout: 3_000 });

  await page.keyboard.press('Escape');
  await expect(searchBar).not.toBeVisible();
});

test('settings panel opens with mod+comma', async ({ shelfApp: { page } }) => {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  // Has theme selector
  const themeSelect = page.locator('.settings-select');
  await expect(themeSelect).toBeVisible();

  // Has keybinding section
  const keybindingBtn = page.locator('.keybinding-btn').first();
  await expect(keybindingBtn).toBeVisible();

  // Close
  await page.locator('.settings-close').click();
  await expect(panel).not.toBeVisible();
});

test('project edit panel opens from context menu', async ({ shelfApp: { page } }) => {
  // Ensure project exists
  if (await page.locator('.sidebar-item').count() === 0) {
    await setupProject(page);
  }

  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible({ timeout: 3_000 });

  await page.locator('.context-menu-item').first().click();

  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });

  // Has init script textarea
  const textarea = page.locator('.project-edit-textarea');
  await expect(textarea).toBeVisible();

  // Close
  await page.locator('.settings-close').click();
  await expect(editPanel).not.toBeVisible();
});
