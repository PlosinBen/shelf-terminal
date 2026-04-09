import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function getUserDataDir() {
  const suffix = process.env.NODE_ENV ? `-${process.env.NODE_ENV}` : '';
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', `shelf-terminal${suffix}`)
    : path.join(os.homedir(), '.config', `shelf-terminal${suffix}`);
}

/** Pre-seed a project with an initScript before launching the app. */
const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = getUserDataDir();
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const project = {
      id: 'init-test',
      name: 'Init Test',
      cwd: os.homedir(),
      connection: { type: 'local' },
      maxTabs: 4,
      initScript: 'echo __INIT_MARKER__',
      defaultTabs: [{ name: 'shell' }],
    };
    fs.writeFileSync(
      path.join(userDataDir, 'projects.json'),
      JSON.stringify([project]),
      'utf-8',
    );

    const app = await electron.launch({
      args: [path.join(__dirname, '..')],
      env: { ...process.env },
    });

    let page: Page;
    try {
      page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
    } catch (err) {
      await app.close().catch(() => {});
      throw err;
    }

    await use({ app, page });
    await app.close().catch(() => {});
  }, { scope: 'worker' }],
});

test('init script command should not appear twice in terminal output', async ({ shelfApp: { page } }) => {
  // Connect to the pre-seeded project
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  // Wait for init script to execute and output to appear
  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await expect(xtermRows).toContainText('__INIT_MARKER__', { timeout: 10_000 });

  // Wait a bit for all output to settle
  await page.waitForTimeout(2000);

  // Get full terminal text and count occurrences of the command
  const text = await xtermRows.textContent() ?? '';
  const cmdOccurrences = text.split('echo __INIT_MARKER__').length - 1;

  // The command should appear exactly once (typed by shell), not twice
  expect(cmdOccurrences).toBe(1);
});
