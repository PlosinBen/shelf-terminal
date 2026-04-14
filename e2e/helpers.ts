import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function getUserDataDir() {
  const suffix = process.env.NODE_ENV ? `-${process.env.NODE_ENV}` : '';
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', `shelf-terminal${suffix}`)
    : path.join(os.homedir(), '.config', `shelf-terminal${suffix}`);
}

function clearProjectsData() {
  const userDataDir = getUserDataDir();

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), '[]', 'utf-8');

  // Remove saved settings so tests start with defaults
  const settingsPath = path.join(userDataDir, 'settings.json');
  if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
}

/** Ensure home directory has enough subdirectories for folder picker tests */
function ensureTestDirectories() {
  const home = os.homedir();
  for (const name of ['shelf-test-a', 'shelf-test-b', 'shelf-test-c']) {
    const dir = path.join(home, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  }
}

function cleanupTestDirectories() {
  const home = os.homedir();
  for (const name of ['shelf-test-a', 'shelf-test-b', 'shelf-test-c']) {
    const dir = path.join(home, name);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  }
}

/**
 * Custom test fixture that guarantees Electron is killed even on failure.
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    clearProjectsData();
    ensureTestDirectories();

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

    // Always runs — even after test failures
    await app.close().catch(() => {});
    cleanupTestDirectories();
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
