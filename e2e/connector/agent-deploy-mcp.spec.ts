import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openAgentTab, sendAgentPrompt } from '../helpers';

/**
 * MCP remote sync (docker), end-to-end over the REAL transport → DockerConnector
 * → container. Seeds an app-level mcp-servers.json into userData, opens an agent
 * tab on a docker connection (deploy runs syncMcpForConnection → transportPut →
 * connector.putFile), and asserts the config landed at the remote's
 * ~/.shelf/apps/<appId>/mcp-servers.json. This exercises the real production path
 * (not file-utils directly). The ssh channel is covered by ssh.spec's uploadFile
 * test (same spawnPipeWrite + sshExecArgs). See features/app-level-mcps.
 */

const CONTAINER = 'shelf-agent-test'; // started by `npm run test:agent-deploy`

const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mcp-deploy-'));
    const runtimeCacheDir = path.join(os.tmpdir(), 'shelf-rt-cache-e2e');
    fs.mkdirSync(runtimeCacheDir, { recursive: true });

    fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
      everything: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
    }), 'utf-8');

    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([{
      id: 'mcp-deploy-test',
      name: 'MCP Deploy Test',
      cwd: '/tmp',
      connection: { type: 'docker', container: CONTAINER },
      maxTabs: 4,
    }]), 'utf-8');

    // Clean any prior projected config on the container so the assertion is fresh.
    try { execSync(`docker exec ${CONTAINER} sh -c 'rm -rf /root/.shelf/apps'`, { stdio: 'pipe' }); } catch { /* ignore */ }

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

test.setTimeout(180_000);

test('docker: app-level MCP config is synced to the remote on agent deploy', async ({ shelfApp: { page } }) => {
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  // Opening the tab + a round-trip proves deploy ran (so syncMcpForConnection ran).
  await openAgentTab(page);
  await sendAgentPrompt(page, 'picker_single');
  await expect(page.locator('.picker-panel:visible')).toBeVisible({ timeout: 150_000 });

  // The config landed under the projected per-app dir on the remote — placed via
  // the real transport (type-declared placement) → DockerConnector.putFile. The
  // app-dir heartbeat (touched at deploy) keeps the startup sweep from reclaiming
  // it even though this app has no skills.
  const found = execSync(
    `docker exec ${CONTAINER} sh -c 'cat /root/.shelf/apps/*/mcp-servers.json 2>/dev/null || true'`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(found).toContain('everything');
  expect(found).toContain('@modelcontextprotocol/server-everything');
});
