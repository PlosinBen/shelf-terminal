import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SSH_TEST } from './ssh-config';

/**
 * Pre-seed a project with SSH connection before launching the app. Uses a
 * fresh tmpdir via --user-data-dir (userData isolation switched to that since
 * commit d27fc26; NODE_ENV-based paths are gone). The tmpdir also gives us a
 * clean ssh_known_hosts so container rebuilds never hit host-key mismatches.
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ssh-'));

    const project = {
      id: 'ssh-test',
      name: 'SSH Test',
      cwd: '/tmp',
      connection: {
        type: 'ssh',
        host: SSH_TEST.host,
        port: SSH_TEST.port,
        user: SSH_TEST.user,
        password: SSH_TEST.password,
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
