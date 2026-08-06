import { test, expect } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('backup operation panel opens from the footer and resets to Back up after close', async ({ shelfApp: { page } }) => {
  const toggle = page.locator('.right-tab-btn[title="Backup"]');
  await expect(toggle).toBeVisible();

  await toggle.click();
  const panel = page.locator('.backup-view');
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveClass(/active/);

  const backupTab = panel.getByRole('tab', { name: 'Back up' });
  const importTab = panel.getByRole('tab', { name: 'Import' });
  await expect(backupTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Back up selected Skills and MCP servers.')).toBeVisible();

  await importTab.click();
  await expect(importTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Import Skills and MCP servers from a backup.')).toBeVisible();

  await panel.getByRole('button', { name: 'Close Backup' }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).not.toHaveClass(/active/);

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(backupTab).toHaveAttribute('aria-selected', 'true');
});

test('Settings no longer exposes a Backup tab', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-tab', { hasText: 'Backup' })).toHaveCount(0);
});
