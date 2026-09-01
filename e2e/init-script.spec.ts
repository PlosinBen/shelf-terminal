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
      initScript: 'sleep 2; echo __INIT_MARKER__',
      defaultTabs: [{ name: 'shell', cmd: 'echo __TAB_MARKER__' }],
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

test('init script is internal, input-gated, then tab command opens interaction', async ({ shelfApp: { page } }) => {
  // Connect to the pre-seeded project
  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  // Runner initialization is globally covered. Once the cover disappears the
  // initScript is visible but main still accepts only Ctrl-C. Submit arbitrary
  // input directly through the public bridge while the 2s script is running;
  // it must be discarded rather than buffered for the later prompt.
  await expect(page.locator('.terminal-loading')).toBeHidden({ timeout: 5_000 });
  await page.evaluate(() => {
    const cache = (window as any).__shelfTerminalCache__ as Map<string, unknown>;
    const tabId = [...cache.keys()][0];
    (window as any).shelfApi.pty.input(tabId, 'echo __BLOCKED_DURING_INIT__\n');
  });

  // Wait for init script output to appear (poll xterm buffer; WebGL renderer
  // paints to canvas so `.xterm-rows` is empty).
  await expect.poll(
    async () => await readActiveTerminalText(page),
    { timeout: 10_000, message: 'init script output did not appear' },
  ).toContain('__INIT_MARKER__');

  await expect.poll(
    async () => await readActiveTerminalText(page),
    { timeout: 10_000, message: 'tab command was not submitted after initScript success' },
  ).toContain('__TAB_MARKER__');

  await page.evaluate(() => {
    const cache = (window as any).__shelfTerminalCache__ as Map<string, unknown>;
    const tabId = [...cache.keys()][0];
    (window as any).shelfApi.pty.input(tabId, 'echo __AFTER_INIT__\n');
  });
  await expect.poll(async () => await readActiveTerminalText(page), { timeout: 5_000 })
    .toContain('__AFTER_INIT__');

  // Wait a bit for all output to settle
  await page.waitForTimeout(2000);

  // The project-wide script runs as internal hook code, so its command line is
  // not typed into the interactive shell or stored as a normal command.
  const text = await readActiveTerminalText(page);
  const cmdOccurrences = text.split('echo __INIT_MARKER__').length - 1;
  expect(cmdOccurrences).toBe(0);
  expect(text).not.toContain('__BLOCKED_DURING_INIT__');
});
