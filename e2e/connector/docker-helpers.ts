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

/**
 * Pre-seed a project with Docker connection before launching the app.
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = getUserDataDir();
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

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
      args: [path.join(__dirname, '../..')],
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

export { expect } from '@playwright/test';
