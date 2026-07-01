import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * The tab `+` menu lists THIS project's granted web origins (web-grants.json)
 * as one-click "reopen this internal service to log in" shortcuts — see
 * web-tab#10. Two invariants:
 *   1. only the ACTIVE project's grants appear (never another project's), and
 *   2. clicking one opens a web tab pre-navigated to that origin.
 *
 * Pre-seed grants on disk (a grant is normally created by approving a
 * web.fetch; here we write the file directly to avoid the agent round-trip).
 */

const ACTIVE_ID = 'ql-active';
const OTHER_ID = 'ql-other';
const ACTIVE_ORIGIN = 'https://argocd.example.com';
const OTHER_ORIGIN = 'https://leaked.example.com';

const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ql-'));

    const project = {
      id: ACTIVE_ID,
      name: 'QuickLinks',
      cwd: os.homedir(),
      connection: { type: 'local' },
      maxTabs: 8,
    };
    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');

    // Grant file for the active project (surfaces in its + menu)...
    const activeDir = path.join(userDataDir, 'projects', ACTIVE_ID);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'web-grants.json'), JSON.stringify([ACTIVE_ORIGIN]), 'utf-8');
    // ...and a DECOY grant for a different project that must NOT leak in.
    const otherDir = path.join(userDataDir, 'projects', OTHER_ID);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'web-grants.json'), JSON.stringify([OTHER_ORIGIN]), 'utf-8');

    const app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' },
    });

    let page: Page;
    try {
      page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
    } catch (err) {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
      throw err;
    }

    await use({ app, page });
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, { scope: 'worker' }],
});

test.describe('web quick-links (web-tab#10)', () => {
  test('the + menu shows only the active project grants and opens a tab at the origin', async ({ shelfApp: { page } }) => {
    // Connect to the pre-seeded project.
    const prompt = page.locator('.connect-prompt');
    if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await prompt.click();
    }
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

    await page.locator('.tab-add').click();

    // The active project's granted origin appears as a Web shortcut...
    const shortcut = page.locator('.context-menu-item-web-origin', { hasText: ACTIVE_ORIGIN });
    await expect(shortcut).toBeVisible({ timeout: 5_000 });
    // ...and another project's grant never leaks in (per-project scoping).
    await expect(page.locator('.context-menu', { hasText: OTHER_ORIGIN })).toHaveCount(0);

    await shortcut.click();

    // A new web tab opened, pre-navigated to the granted origin (the address bar
    // reflects the initial URL even though the fake origin never loads).
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.web-tab-address:visible')).toHaveValue(ACTIVE_ORIGIN, { timeout: 5_000 });
  });
});
