import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function createProject(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
}

async function removeActiveProject(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-item.active').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Remove' }).click();
  await page.locator('.conn-btn-danger', { hasText: 'Remove' }).click();
}

test('failed project save retries without crashing or publishing early', async ({ shelfApp: { app, page, userDataDir } }) => {
  const configPath = path.join(userDataDir, 'projects.json');
  fs.rmSync(configPath);
  fs.mkdirSync(configPath);
  await app.evaluate(({ dialog }, targetPath) => {
    const mainFs = process.getBuiltinModule('node:fs');
    (globalThis as any).__projectRecoveryPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project update failed') {
        (globalThis as any).__projectRecoveryPrompts++;
        mainFs.rmSync(targetPath, { recursive: true });
        mainFs.writeFileSync(targetPath, '[]', 'utf8');
        return { response: 0, checkboxChecked: false };
      }
      return { response: 1, checkboxChecked: false };
    };
  }, configPath);

  await createProject(page);

  await expect(page.locator('.sidebar-item')).toHaveCount(1, { timeout: 8_000 });
  expect(await app.evaluate(() => (globalThis as any).__projectRecoveryPrompts)).toBe(1);
  const document = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(document.schemaVersion).toBe(1);
  expect(document.projects).toHaveLength(1);
});

test('cancelled project save keeps the prior renderer state', async ({ shelfApp: { app, page, userDataDir } }) => {
  const configPath = path.join(userDataDir, 'projects.json');
  fs.rmSync(configPath);
  fs.mkdirSync(configPath);
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__projectRecoveryPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project update failed') {
        (globalThis as any).__projectRecoveryPrompts++;
      }
      return { response: 1, checkboxChecked: false };
    };
  });

  await createProject(page);

  await expect.poll(() => app.evaluate(() => (globalThis as any).__projectRecoveryPrompts)).toBe(1);
  await expect(page.locator('.sidebar-item')).toHaveCount(0);
  await expect(page.locator('.app')).toBeVisible();
  fs.rmSync(configPath, { recursive: true });
  fs.writeFileSync(configPath, '[]', 'utf8');
});

test('post-commit cleanup retries without restoring the deleted project', async ({ shelfApp: { app, page } }) => {
  await createProject(page);
  await expect(page.locator('.sidebar-item')).toHaveCount(1);
  await app.evaluate(({ dialog }) => {
    const mainFs = process.getBuiltinModule('node:fs');
    const originalRm = mainFs.promises.rm.bind(mainFs.promises);
    let failOnce = true;
    (mainFs.promises as any).rm = async (...args: unknown[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated cleanup failure');
      }
      return originalRm(...args as Parameters<typeof originalRm>);
    };
    (globalThis as any).__projectCleanupPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project removed with leftover data') {
        (globalThis as any).__projectCleanupPrompts++;
        return { response: 0, checkboxChecked: false };
      }
      return { response: 1, checkboxChecked: false };
    };
  });

  await removeActiveProject(page);

  await expect(page.locator('.sidebar-item')).toHaveCount(0, { timeout: 8_000 });
  await expect.poll(() => app.evaluate(() => (globalThis as any).__projectCleanupPrompts)).toBe(1);
  await expect(page.locator('.app')).toBeVisible();
});

test('cancelled cleanup leaves the durable deletion intact', async ({ shelfApp: { app, page } }) => {
  await createProject(page);
  await expect(page.locator('.sidebar-item')).toHaveCount(1);
  await app.evaluate(({ dialog }) => {
    const mainFs = process.getBuiltinModule('node:fs');
    (mainFs.promises as any).rm = async () => {
      throw new Error('simulated persistent cleanup failure');
    };
    (globalThis as any).__projectCleanupPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project removed with leftover data') {
        (globalThis as any).__projectCleanupPrompts++;
      }
      return { response: 1, checkboxChecked: false };
    };
  });

  await removeActiveProject(page);

  await expect(page.locator('.sidebar-item')).toHaveCount(0, { timeout: 8_000 });
  await expect.poll(() => app.evaluate(() => (globalThis as any).__projectCleanupPrompts)).toBe(1);
  await expect(page.locator('.app')).toBeVisible();
});
