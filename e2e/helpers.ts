import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function createTempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-e2e-'));
}

function seedProjectsData(userDataDir: string) {
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), '[]', 'utf-8');
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
    const userDataDir = createTempUserDataDir();
    seedProjectsData(userDataDir);
    ensureTestDirectories();

    const app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
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
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
