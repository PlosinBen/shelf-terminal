import { test, expect } from './helpers';
import fs from 'fs';
import path from 'path';

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
  await expect(panel.locator('.backup-config-form')).toBeVisible();

  await importTab.click();
  await expect(importTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Import Skills and MCP servers from a backup.')).toBeVisible();

  await panel.getByRole('button', { name: 'Close Backup' }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).not.toHaveClass(/active/);

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(backupTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.backup-config-form')).toBeVisible();
});

test('Settings no longer exposes a Backup tab', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-tab', { hasText: 'Backup' })).toHaveCount(0);
});

test('Back up config saves, cancels edits, and clears through its single form', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;
  const bindingPath = path.join(userDataDir, 'config-backup.json');

  await page.locator('.right-tab-btn[title="Backup"]').click();
  const panel = page.locator('.backup-view');
  const form = panel.locator('.backup-config-form');
  await expect(form).toBeVisible();

  const remoteInput = form.getByLabel('Remote URL');
  const labelInput = form.getByLabel("This machine's label");
  await expect(labelInput).not.toHaveValue('');

  // A label-only partial setting may persist for compatibility, but it remains
  // unconfigured and never enters the ready summary state.
  await labelInput.fill('partial-machine');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form).toBeVisible();
  await expect(panel.locator('.backup-config-summary')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '',
    machineLabel: 'partial-machine',
  });

  await remoteInput.fill('/tmp/shelf-backup.git');
  await form.getByRole('button', { name: 'Save settings' }).click();
  const summary = panel.locator('.backup-config-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('/tmp/shelf-backup.git');
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '/tmp/shelf-backup.git',
    machineLabel: 'partial-machine',
  });

  // Cancel restores the saved values without touching persistence.
  await summary.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('Remote URL').fill('/tmp/unsaved.git');
  await form.getByLabel("This machine's label").fill('unsaved-machine');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(summary).toContainText('/tmp/shelf-backup.git');
  await expect(summary).toContainText('partial-machine');
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '/tmp/shelf-backup.git',
    machineLabel: 'partial-machine',
  });

  // Clear uses the same Save boundary; there is no independent Unbind action.
  await summary.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('Remote URL').fill('');
  await form.getByLabel("This machine's label").fill('');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form).toBeVisible();
  expect(fs.existsSync(bindingPath)).toBe(false);
});
