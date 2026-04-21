import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Pre-seed a project with Docker connection before launching the app.
 * Uses a fresh tmpdir via --user-data-dir so we don't touch the developer's
 * real data — userData isolation is driven by this switch since commit
 * d27fc26, not by NODE_ENV.
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-docker-'));

    const project = {
      id: 'docker-test',
      name: 'Docker Test',
      cwd: '/tmp',
      connection: {
        type: 'docker',
        container: 'shelf-test-container',
      },
      maxTabs: 4,
    };
    fs.writeFileSync(
      path.join(userDataDir, 'projects.json'),
      JSON.stringify([project]),
      'utf-8',
    );

    const app = await electron.launch({
      args: [path.join(__dirname, '../..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env },
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

export { expect } from '@playwright/test';
