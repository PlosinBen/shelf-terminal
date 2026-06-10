import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openAgentTab, sendAgentPrompt } from '../helpers';

/**
 * L3a skills remote sync (docker). Seeds an app-level skill into userData, opens
 * a Claude agent tab on a docker connection (which runs the real deploy +
 * syncSkillsToRemote, fake provider for the turn), and asserts the skill landed
 * at the remote's ~/.shelf/apps/<appId>/skills (see #70/§5.7).
 */

const CONTAINER = 'shelf-agent-test'; // started by `npm run test:agent-deploy`

function seedSkill(userDataDir: string, name: string, body: string) {
  const dir = path.join(userDataDir, 'skills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  const manifest = path.join(userDataDir, 'skills', '.claude-plugin');
  fs.mkdirSync(manifest, { recursive: true });
  fs.writeFileSync(path.join(manifest, 'plugin.json'), '{"name":"shelf-skills"}');
}

const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-skills-deploy-'));
    const runtimeCacheDir = path.join(os.tmpdir(), 'shelf-rt-cache-e2e');
    fs.mkdirSync(runtimeCacheDir, { recursive: true });

    seedSkill(userDataDir, 'kibana-connect', '---\nname: kibana-connect\ndescription: reach kibana\n---\n\nssh to bastion');

    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([{
      id: 'skills-deploy-test',
      name: 'Skills Deploy Test',
      cwd: '/tmp',
      connection: { type: 'docker', container: CONTAINER },
      maxTabs: 4,
    }]), 'utf-8');

    // Clean any prior projected skills on the container so the assertion is fresh.
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

test('docker: app-level skill is synced to the remote on agent deploy', async ({ shelfApp: { page } }) => {
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  // Opening the tab + a round-trip proves deploy + spawn ran (so sync ran too).
  await openAgentTab(page);
  await sendAgentPrompt(page, 'picker_single');
  await expect(page.locator('.picker-panel:visible')).toBeVisible({ timeout: 150_000 });

  // The skill file landed under the projected per-app dir on the remote.
  const found = execSync(
    `docker exec ${CONTAINER} sh -c 'cat /root/.shelf/apps/*/skills/skills/kibana-connect/SKILL.md 2>/dev/null'`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(found).toContain('name: kibana-connect');
  expect(found).toContain('ssh to bastion');

  // The plugin scaffold + content-hash sentinel came across too.
  const synced = execSync(
    `docker exec ${CONTAINER} sh -c 'ls /root/.shelf/apps/*/skills/.synced /root/.shelf/apps/*/skills/.claude-plugin/plugin.json 2>/dev/null'`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(synced).toContain('.synced');
  expect(synced).toContain('plugin.json');
});
