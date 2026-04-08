import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function clearProjectsData() {
  const userDataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'shelf-terminal-test')
    : path.join(os.homedir(), '.config', 'shelf-terminal-test');

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), '[]', 'utf-8');
}

/**
 * Custom test fixture that guarantees Electron is killed even on failure.
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    clearProjectsData();

    const app = await electron.launch({
      args: [path.join(__dirname, '..')],
      env: { ...process.env, NODE_ENV: 'test' },
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

    // Always runs — even after test failures
    await app.close().catch(() => {});
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
