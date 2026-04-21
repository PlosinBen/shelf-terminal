import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { readActiveTerminalText } from './helpers';

/** Pre-seed a project with an initScript before launching the app. */
const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    // Fresh tmpdir so we don't touch the developer's real userData — userData
    // isolation is driven by --user-data-dir since commit d27fc26, not by
    // NODE_ENV.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-init-'));

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
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
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

test('init script command should not appear twice in terminal output', async ({ shelfApp: { page } }) => {
  // Connect to the pre-seeded project
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  // Wait for init script output to appear (poll xterm buffer; WebGL renderer
  // paints to canvas so `.xterm-rows` is empty).
  await expect.poll(
    async () => await readActiveTerminalText(page),
    { timeout: 10_000, message: 'init script output did not appear' },
  ).toContain('__INIT_MARKER__');

  // Wait a bit for all output to settle
  await page.waitForTimeout(2000);

  // Count occurrences of the command — should be exactly once (typed by shell),
  // not twice (which would indicate the init script line was both typed and
  // echoed separately).
  const text = await readActiveTerminalText(page);
  const cmdOccurrences = text.split('echo __INIT_MARKER__').length - 1;
  expect(cmdOccurrences).toBe(1);
});
