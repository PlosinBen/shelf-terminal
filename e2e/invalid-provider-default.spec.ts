import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ID = 'stale-provider-project';
const STALE_PROVIDER = 'codex-offical';

test.describe('unavailable persisted startup provider', () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let repo: string;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-stale-provider-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-stale-provider-repo-'));
    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([{
      id: PROJECT_ID,
      name: 'Stale Provider',
      cwd: repo,
      connection: { type: 'local' },
      maxTabs: 5,
      defaultAgentProvider: STALE_PROVIDER,
      openAgentOnConnect: true,
    }]), 'utf-8');
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('preserves and displays the stale provider without opening it', async () => {
    await page.locator('.sidebar-item').click();
    const connect = page.locator('.connect-prompt');
    if (await connect.isVisible().catch(() => false)) await connect.click();

    await expect(page.locator('.agent-view')).toHaveCount(0);

    await page.locator('.sidebar-item').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
    const edit = page.locator('.project-edit-panel');
    const agentRow = edit.locator('.default-tab-row', { has: page.locator('.default-tab-kind-agent') });
    const provider = agentRow.locator('.default-tab-provider');
    await expect(provider).toHaveValue(STALE_PROVIDER);
    await expect(provider.locator(`option[value="${STALE_PROVIDER}"]`)).toContainText('unavailable');
    await edit.locator('.settings-input').first().fill('Renamed Project');
    await edit.locator('.project-edit-footer .conn-btn-next').click();

    await expect.poll(() => {
      const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8'));
      const projects = Array.isArray(document) ? document : document.projects;
      return {
        schemaVersion: Array.isArray(document) ? 0 : document.schemaVersion,
        provider: projects[0]?.defaultTabs?.find((tab: any) => tab.kind === 'agent')?.provider,
        hasLegacyProvider: Object.hasOwn(projects[0] ?? {}, 'defaultAgentProvider'),
      };
    }).toEqual({ schemaVersion: 2, provider: STALE_PROVIDER, hasLegacyProvider: false });

    await page.locator('.sidebar-item').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'New Worktree' }).click();
    const worktree = page.locator('.worktree-dialog');
    await expect(worktree.locator('.worktree-select')).toHaveCount(0);
    await worktree.locator('input').first().fill('provider-proof');
    await expect(worktree.locator('.project-edit-footer .conn-btn-next')).toBeEnabled();
    await worktree.locator('.conn-btn-cancel').click();

    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Codex)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible();
  });
});
