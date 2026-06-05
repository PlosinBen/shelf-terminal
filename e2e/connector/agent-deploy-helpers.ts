import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Fixture for the R1 self-contained-deploy E2E. Seeds a Docker connection to a
 * glibc container (started by the `test:agent-deploy` npm script as
 * `shelf-agent-test`, e.g. debian — NOT the Alpine/musl openssh container,
 * which Phase 1 deliberately rejects).
 *
 * - SHELF_TEST_MODE=1 → agent-server uses the fake provider, so the agent turn
 *   round-trips without real Claude auth. The full 3-file deploy (node +
 *   index.mjs + claude) still runs, exercising deploySelfContained end to end.
 * - SHELF_RUNTIME_CACHE_DIR → a persistent dir so the node/claude downloads are
 *   reused across runs (the per-test userData is throwaway).
 */
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-agentdeploy-'));
    const runtimeCacheDir = path.join(os.tmpdir(), 'shelf-rt-cache-e2e');
    fs.mkdirSync(runtimeCacheDir, { recursive: true });

    const project = {
      id: 'agent-deploy-test',
      name: 'Agent Deploy Test',
      cwd: '/tmp',
      connection: { type: 'docker', container: 'shelf-agent-test' },
      maxTabs: 4,
    };
    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');

    const app = await electron.launch({
      args: [path.join(__dirname, '../..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', SHELF_RUNTIME_CACHE_DIR: runtimeCacheDir },
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
