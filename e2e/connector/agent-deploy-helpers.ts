import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openAgentTab, sendAgentPrompt } from '../helpers';

/**
 * Fixtures for the R1 self-contained-deploy E2E, parametrized by container.
 *
 * - SHELF_TEST_MODE=1 → agent-server uses the fake provider, so the agent turn
 *   round-trips without real Claude auth. The full deploy still runs end to end.
 * - SHELF_RUNTIME_CACHE_DIR → persistent so node/claude downloads are reused.
 *
 * The glibc container has NO node (we ship ours); the musl container is
 * node:alpine (has node — we use the remote's, shipping only index.mjs + claude).
 */
export function makeShelfAppFixture(container: string) {
  return base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
    shelfApp: [async ({}, use) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-agentdeploy-'));
      const runtimeCacheDir = path.join(os.tmpdir(), 'shelf-rt-cache-e2e');
      fs.mkdirSync(runtimeCacheDir, { recursive: true });

      const project = {
        id: 'agent-deploy-test',
        name: 'Agent Deploy Test',
        cwd: '/tmp',
        connection: { type: 'docker', container },
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
}

/** True if the container has `node` on PATH. */
export function containerHasNode(container: string): boolean {
  try {
    execSync(`docker exec ${container} sh -c 'command -v node'`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** List files in the container's deploy root (empty array if none). */
export function deployedFiles(container: string): string[] {
  try {
    const out = execSync(
      `docker exec ${container} sh -c 'ls /root/.shelf/agent-server/*/ 2>/dev/null'`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Drive a fake picker turn and assert the panel appears — only possible if the
 * remote agent-server actually ran (deploy + spawn worked). A text echo would
 * be satisfied by the user's own bubble, so we use the picker (distinct DOM).
 */
export async function assertPickerRoundTrip(page: Page): Promise<void> {
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  await openAgentTab(page);
  await sendAgentPrompt(page, 'picker_single');
  const panel = page.locator('.picker-panel:visible');
  await expect(panel).toBeVisible({ timeout: 150_000 });
  await expect(panel.locator('.picker-option')).toHaveCount(3);
}

export { expect } from '@playwright/test';
